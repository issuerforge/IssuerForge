// The officer's screen, walked through the api on devnet (T034).
//
// Every step the screen takes goes through the same handler here, and every
// transaction the api hands back is signed by the wallet it names and sent to
// the node — the console's own path, with the demo's keys in place of Privy.
// After each action the run reads the totals back from the api and checks
// them against what the action should have done (FR-014, FR-015, FR-016,
// FR-020): a screen that draws stale numbers looks exactly like one that
// draws the right ones.
//
//   node --env-file=.env tools/demo/src/officer.ts \
//     --rpc https://api.devnet.solana.com --payer ~/.config/solana/id.json \
//     --api http://127.0.0.1:8787
//
// The api must run with `RUN_WORKER=true`: the login waits for the indexer
// to mirror the new issuer's membership.
import {
  type ActionTransactionResponse,
  actionTransactionResponseSchema,
  proposalDetailResponseSchema,
  proposalListResponseSchema,
  proposeActionResponseSchema,
} from '@forge/api/contracts/actions'
import {
  complianceSummarySchema,
  officerTransactionResponseSchema,
  tokenListResponseSchema,
} from '@forge/api/contracts/compliance'
import { buildTransfer, fromBase64 } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { ISSUER_HEADER } from '@forge/shared/api'
import type { Keypair } from '@solana/web3.js'
import { createContext, fund, keypairFromBase58, loadKeypair } from './context.ts'
import { ataOf, onboard } from './holders.ts'
import { issueToken } from './issuance.ts'
import { createIssuer } from './issuer.ts'
import { send, submitPlan } from './send.ts'
import { openApiSession, required } from './session.ts'

const POLICY: PolicyRules = {
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 24 * 3600 },
}

const SUPPLY = 2_500_000_000n
const TO_ALICE = 10_000n
const SEIZED = 2_500n
const TERM_SECONDS = 3600

function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const rpc = option(argv, '--rpc') ?? 'https://api.devnet.solana.com'
  const base = (option(argv, '--api') ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const payerPath = option(argv, '--payer')
  if (payerPath === undefined) throw new Error('--payer is required: the run spends real SOL')

  const context = createContext(rpc, {
    operational: keypairFromBase58(required('OPERATIONAL_SECRET_KEY')),
  })
  const { keys, connection } = context
  const payer = loadKeypair(payerPath)
  await fund(connection, keys.founder.publicKey, 0.12, payer)
  await fund(connection, keys.officer.publicKey, 0.03, payer)
  await fund(connection, keys.operational.publicKey, 0.02, payer)

  const issuer = await createIssuer(context)
  const issuerId = issuer.issuerId.toBase58()
  console.log(`issuer:  ${issuerId}`)
  const session = await openApiSession(context, issuer.issuerId, base)

  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(44)} ${detail}`)
  }

  /** One api call the way the console makes it, the response checked against the contract. */
  async function call<T>(
    method: string,
    path: string,
    schema: { parse(value: unknown): T },
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.login.accessToken}`,
        [ISSUER_HEADER]: issuerId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload: unknown = await response.json()
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`)
    return schema.parse(payload)
  }

  /** Signs what the api assembled with the wallet it named, and lands it. */
  async function land(
    assembled: { signer: string; transaction: { base64: string; signers: string[] } },
    wallet: Keypair,
  ): Promise<string> {
    if (assembled.transaction.signers.join() !== wallet.publicKey.toBase58()) {
      throw new Error(`the api named ${assembled.transaction.signers.join()} to sign`)
    }
    const transaction = fromBase64(assembled.transaction.base64)
    transaction.sign([wallet])
    return (await send(connection, transaction)).signature
  }

  const founder = keys.founder.publicKey.toBase58()
  const officer = keys.officer.publicKey.toBase58()

  try {
    const issuance = await issueToken(context, {
      issuerId: issuer.issuerId,
      tokenIndex: 0,
      decimals: 2,
      policy: POLICY,
      initialSupply: SUPPLY,
      reserveAmount: 2_540_000_000n,
      reserveCurrency: 'NGN',
      feeBps: 12,
      attestationMaxAge: BigInt(24 * 3600),
      name: 'Vantara Naira',
      symbol: 'vNGN',
      uri: 'https://vantara.example/vngn.json',
    })
    const mint = issuance.addresses.mint.toBase58()
    console.log(`mint:    ${mint}`)

    await onboard(context, issuance.addresses.mint, issuer.issuerId, keys.alice, {
      tier: 2,
      jurisdiction: 'NG',
      denied: false,
      expiresAt: 0n,
    })
    await submitPlan(
      connection,
      await buildTransfer(connection, {
        mint: issuance.addresses.mint,
        owner: keys.founder.publicKey,
        recipient: keys.alice.publicKey,
        amount: TO_ALICE,
        decimals: 2,
      }),
      [keys.founder],
    )
    const aliceAccount = ataOf(issuance.addresses.mint, keys.alice.publicKey).toBase58()
    console.log('')

    const summary = () => call('GET', `/api/tokens/${mint}/compliance`, complianceSummarySchema)

    // ─── The list the screen opens on ───────────────────────────────────────
    const { tokens } = await call('GET', '/api/tokens', tokenListResponseSchema)
    const listed = tokens.find((token) => token.mint === mint)
    check(
      'the token is listed, from the chain',
      tokens.length === 1 && listed?.symbol === 'vNGN' && listed.supply === SUPPLY.toString(),
      `${tokens.length} token · ${listed?.symbol} · supply ${listed?.supply}`,
    )

    // ─── Freeze (FR-014): the officer alone ─────────────────────────────────
    const reason = { code: 4, caseRef: 'FIU-NG/2026/004117' }
    const freezing = await call(
      'POST',
      `/api/tokens/${mint}/freezes?signer=${officer}`,
      officerTransactionResponseSchema,
      { wallet: keys.alice.publicKey.toBase58(), reason },
    )
    check(
      'freeze names the wallet’s account',
      freezing.tokenAccount === aliceAccount,
      freezing.tokenAccount,
    )
    console.log(`         freeze ${await land(freezing, keys.officer)}`)

    let totals = await summary()
    check(
      'frozen balance kept apart (FR-020)',
      totals.frozen.amount === TO_ALICE.toString() &&
        totals.free === (SUPPLY - TO_ALICE).toString() &&
        totals.frozen.accounts[0]?.reason.caseRef === reason.caseRef,
      `frozen ${totals.frozen.amount} · free ${totals.free} · seized ${totals.seized.amount}`,
    )

    const twice = await fetch(`${base}/api/tokens/${mint}/freezes?signer=${officer}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.login.accessToken}`,
        [ISSUER_HEADER]: issuerId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ wallet: keys.alice.publicKey.toBase58(), reason }),
    })
    check('a second freeze is refused before signing', twice.status === 400, `${twice.status}`)

    const byAdmin = await fetch(`${base}/api/tokens/${mint}/freezes?signer=${founder}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.login.accessToken}`,
        [ISSUER_HEADER]: issuerId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tokenAccount: aliceAccount, reason }),
    })
    check('the admin’s wallet cannot freeze', byAdmin.status === 400, `${byAdmin.status}`)

    // ─── A quorum action, step by step as the proposal page takes it ────────
    async function byQuorum(action: unknown, label: string): Promise<string> {
      const raised = await call(
        'POST',
        `/api/tokens/${mint}/actions?signer=${founder}`,
        proposeActionResponseSchema,
        { action, termSeconds: TERM_SECONDS },
      )
      await land(raised, keys.founder)
      const open = await call(
        'GET',
        `/api/actions/${raised.proposal}`,
        proposalDetailResponseSchema,
      )
      check(
        `${label}: raised, one of two, both seats named`,
        open.proposal.state === 'open' &&
          open.proposal.approvals.join() === founder &&
          open.authorising
            .map((m) => m.wallet)
            .sort()
            .join() === [founder, officer].sort().join(),
        `${open.proposal.state} · ${open.proposal.counted}/${open.proposal.required}`,
      )

      const approved: ActionTransactionResponse = await call(
        'POST',
        `/api/actions/${raised.proposal}/approve?signer=${officer}`,
        actionTransactionResponseSchema,
        {},
      )
      await land(approved, keys.officer)
      const ready = await call(
        'GET',
        `/api/actions/${raised.proposal}`,
        proposalDetailResponseSchema,
      )
      check(
        `${label}: second signature → ready`,
        ready.proposal.state === 'ready' &&
          ready.proposal.approvals.join() === `${founder},${officer}`,
        `${ready.proposal.state} · ${ready.proposal.counted}/${ready.proposal.required}`,
      )

      const executed = await call(
        'POST',
        `/api/actions/${raised.proposal}/execute?signer=${founder}`,
        actionTransactionResponseSchema,
        {},
      )
      console.log(`         ${label} ${await land(executed, keys.founder)}`)
      return raised.proposal
    }

    // ─── Seize (FR-015) from the frozen account ─────────────────────────────
    const seizure = await byQuorum(
      { kind: 'seize', tokenAccount: aliceAccount, amount: SEIZED.toString(), reason },
      'seize',
    )
    totals = await summary()
    check(
      'seized into the vault, frozen reduced (FR-020)',
      totals.seized.amount === SEIZED.toString() &&
        totals.frozen.amount === (TO_ALICE - SEIZED).toString() &&
        totals.free === (SUPPLY - TO_ALICE).toString() &&
        totals.supply === SUPPLY.toString(),
      `frozen ${totals.frozen.amount} · seized ${totals.seized.amount} · free ${totals.free}`,
    )

    // ─── Pause and its lifting (FR-016) ─────────────────────────────────────
    const incident = { code: 8, caseRef: 'INC-2026-0412' }
    const pause = await byQuorum({ kind: 'pause', reason: incident }, 'pause')
    totals = await summary()
    const pausedList = await call('GET', '/api/tokens', tokenListResponseSchema)
    check(
      'paused, read from the mint itself',
      totals.paused && pausedList.tokens[0]?.paused === true,
      `summary ${totals.paused} · list ${pausedList.tokens[0]?.paused}`,
    )
    const resume = await byQuorum({ kind: 'resume', reason: incident }, 'resume')
    totals = await summary()
    check('the pause is lifted', !totals.paused, `paused ${totals.paused}`)

    // ─── Lifting the freeze ─────────────────────────────────────────────────
    const lifting = await call(
      'POST',
      `/api/tokens/${mint}/freezes/${aliceAccount}/unfreeze?signer=${officer}`,
      officerTransactionResponseSchema,
      { reason: { code: 9, caseRef: 'FIU-NG/2026/004117/closed' } },
    )
    console.log(`         unfreeze ${await land(lifting, keys.officer)}`)
    totals = await summary()
    check(
      'the freeze is lifted, the seized stays seized',
      totals.frozen.accounts.length === 0 &&
        totals.seized.amount === SEIZED.toString() &&
        totals.free === (SUPPLY - SEIZED).toString(),
      `frozen ${totals.frozen.amount} · seized ${totals.seized.amount} · free ${totals.free}`,
    )

    // ─── Rent back: every finished proposal closed through the api ──────────
    for (const proposal of [seizure, pause, resume]) {
      const closing = await call(
        'POST',
        `/api/actions/${proposal}/close?signer=${founder}`,
        actionTransactionResponseSchema,
        {},
      )
      await land(closing, keys.founder)
    }
    const left = await call('GET', `/api/tokens/${mint}/actions`, proposalListResponseSchema)
    check(
      'finished proposals closed, rent returned',
      left.proposals.length === 0,
      `${left.proposals.length} left`,
    )

    const failed = checks.filter((c) => !c.ok).length
    console.log(`\nT034:    ${checks.length - failed} of ${checks.length} checks passed`)
    return failed === 0 ? 0 : 1
  } finally {
    await session.close()
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error)
  return 2
})
