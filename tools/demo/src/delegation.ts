// The delegation screen, walked through the api on devnet (T035, FR-035b).
//
// The claim on the screen is "revoked in one action, in force from
// confirmation". The run checks it the only way that means anything: after
// each revocation the platform's key itself tries the power it lost — through
// the api, which must stop offering the delegated path, and straight at the
// program, which must refuse it. Then the quorum gives the power back by
// proposal, the key works again, and the indexer's history must name every
// change with its path and its signers. A raised grant that an admin's later
// revocation overtakes must refuse to execute.
//
//   node --env-file=.env tools/demo/src/delegation.ts \
//     --rpc https://api.devnet.solana.com --payer ~/.config/solana/id.json \
//     --api http://127.0.0.1:8787
//
// The api must run with `RUN_WORKER=true` and migration 0003 applied.
import {
  actionTransactionResponseSchema,
  proposalDetailResponseSchema,
} from '@forge/api/contracts/actions'
import {
  delegationResponseSchema,
  proposeDelegationResponseSchema,
  revokeResponseSchema,
} from '@forge/api/contracts/delegation'
import { buildThawHolder, fromBase64 } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { DELEGATION, ISSUER_HEADER } from '@forge/shared/api'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { createContext, fund, keypairFromBase58, loadKeypair } from './context.ts'
import { createAta } from './holders.ts'
import { issueToken } from './issuance.ts'
import { createIssuer } from './issuer.ts'
import { expectRefusal, PassedThrough, send } from './send.ts'
import { openApiSession, required } from './session.ts'

const POLICY: PolicyRules = {
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 24 * 3600 },
}

const BOTH = DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS
const TERM_SECONDS = 3600
const HISTORY_TIMEOUT_MS = 180_000

function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
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
  const { keys, connection, program } = context
  const payer = loadKeypair(payerPath)
  await fund(connection, keys.founder.publicKey, 0.12, payer)
  await fund(connection, keys.officer.publicKey, 0.03, payer)
  await fund(connection, keys.operational.publicKey, 0.03, payer)

  const issuer = await createIssuer(context)
  const issuerId = issuer.issuerId.toBase58()
  console.log(`issuer:  ${issuerId}`)
  const session = await openApiSession(context, issuer.issuerId, base)

  const checks: { name: string; ok: boolean }[] = []
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(52)} ${detail}`)
  }

  const request = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.login.accessToken}`,
        [ISSUER_HEADER]: issuerId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  async function call<T>(
    method: string,
    path: string,
    schema: { parse(value: unknown): T },
    body?: unknown,
  ): Promise<T> {
    const response = await request(method, path, body)
    const payload: unknown = await response.json()
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`)
    return schema.parse(payload)
  }

  async function land(
    assembled: { transaction: { base64: string; signers: string[] } },
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
  const delegation = () => call('GET', '/api/issuer/delegation', delegationResponseSchema)

  try {
    const issuance = await issueToken(context, {
      issuerId: issuer.issuerId,
      tokenIndex: 0,
      decimals: 2,
      policy: POLICY,
      initialSupply: 2_500_000_000n,
      reserveAmount: 2_540_000_000n,
      reserveCurrency: 'NGN',
      feeBps: 12,
      attestationMaxAge: BigInt(24 * 3600),
      name: 'Vantara Naira',
      symbol: 'vNGN',
      uri: 'https://vantara.example/vngn.json',
    })
    const mint = issuance.addresses.mint
    console.log(`mint:    ${mint.toBase58()}\n`)

    /** Queue a holder and ask the api to thaw it: delegated path → signature, else unsigned. */
    async function thawThroughApi(
      holder: Keypair,
      accountExists = false,
    ): Promise<{ mode: string; signature?: string }> {
      if (!accountExists) await createAta(context, mint, holder.publicKey)
      const queued = await request('POST', `/api/tokens/${mint.toBase58()}/holders`, {
        wallet: holder.publicKey.toBase58(),
        tier: 2,
        jurisdiction: 'NG',
      })
      if (!queued.ok) throw new Error(`queue: ${queued.status} ${await queued.text()}`)
      const response = await request(
        'POST',
        `/api/tokens/${mint.toBase58()}/holders/${holder.publicKey.toBase58()}/thaw`,
      )
      const body = (await response.json()) as {
        mode?: string
        signature?: string
        error?: { message: string }
      }
      // Without a delegation the route falls back to the session's own
      // wallets, and this session holds two that may sign: the api asks which.
      // That question is itself the answer — on the delegated path it signs
      // without asking anyone.
      if (response.status === 400 && body.error?.message.includes('name one') === true) {
        return { mode: 'member' }
      }
      if (!response.ok || body.mode === undefined) {
        throw new Error(`thaw: ${response.status} ${JSON.stringify(body)}`)
      }
      return {
        mode: body.mode,
        ...(body.signature === undefined ? {} : { signature: body.signature }),
      }
    }

    /** The platform's key, straight at the program, tries the power it may have lost. */
    async function keyTriesThaw(holder: PublicKey): Promise<'refused' | 'passed'> {
      const plan = await buildThawHolder(program, {
        issuerId: issuer.issuerId,
        mint,
        wallet: holder,
        payer: keys.operational.publicKey,
        authority: keys.operational.publicKey,
        status: { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: 0n },
      })
      try {
        await expectRefusal(connection, keys.operational.publicKey, plan.instructions, [
          keys.operational,
        ])
        return 'refused'
      } catch (error) {
        if (error instanceof PassedThrough) return 'passed'
        throw error
      }
    }

    // ─── The starting point ─────────────────────────────────────────────────
    let state = await delegation()
    check(
      'the key and both powers, read from the chain',
      state.operationalKey === state.platformKey &&
        state.mask === BOTH &&
        state.history.length === 0,
      `mask ${state.mask} · ${state.powers.join(', ')} · history ${state.history.length}`,
    )
    const first = await thawThroughApi(keys.alice)
    check('the key thaws while it holds the power', first.mode === 'delegated', first.mode)

    // ─── Revoke one power: one admin, now ───────────────────────────────────
    const revokeOne = await call(
      'POST',
      `/api/issuer/delegation/revoke?signer=${founder}`,
      revokeResponseSchema,
      { powers: ['THAW_HOLDER'] },
    )
    console.log(`         revoke THAW_HOLDER ${await land(revokeOne, keys.founder)}`)
    state = await delegation()
    check(
      'one power gone, read back from the chain',
      state.mask === DELEGATION.SET_HOLDER_STATUS,
      `mask ${state.mask}`,
    )
    await createAta(context, mint, keys.bob.publicKey)
    check(
      'the key itself is refused by the program',
      (await keyTriesThaw(keys.bob.publicKey)) === 'refused',
      'thaw_holder signed by the operational key',
    )
    const second = await thawThroughApi(keys.bob, true)
    check(
      'the api stops offering the delegated path',
      second.mode === 'member' && second.signature === undefined,
      second.mode,
    )

    const byOfficer = await request('POST', `/api/issuer/delegation/revoke?signer=${officer}`, {
      powers: ['SET_HOLDER_STATUS'],
    })
    check('an officer cannot revoke alone', byOfficer.status === 400, `${byOfficer.status}`)

    // ─── Revoke everything ──────────────────────────────────────────────────
    const revokeAll = await call(
      'POST',
      `/api/issuer/delegation/revoke?signer=${founder}`,
      revokeResponseSchema,
      { powers: state.powers },
    )
    console.log(`         revoke everything ${await land(revokeAll, keys.founder)}`)
    state = await delegation()
    check('the key holds nothing', state.mask === 0, `mask ${state.mask}`)

    // ─── Give it back: a proposal for the quorum ────────────────────────────
    const raised = await call(
      'POST',
      `/api/issuer/delegation/proposals?signer=${founder}`,
      proposeDelegationResponseSchema,
      { operationalKey: state.operationalKey, mask: BOTH, termSeconds: TERM_SECONDS },
    )
    await land(raised, keys.founder)
    const open = await call('GET', `/api/actions/${raised.proposal}`, proposalDetailResponseSchema)
    check(
      'the grant is a proposal of the issuer, one of two',
      open.proposal.mint === null && open.proposal.state === 'open',
      `${open.proposal.state} · ${open.proposal.counted}/${open.proposal.required}`,
    )
    const approved = await call(
      'POST',
      `/api/actions/${raised.proposal}/approve?signer=${officer}`,
      actionTransactionResponseSchema,
      {},
    )
    await land(approved, keys.officer)
    const executed = await call(
      'POST',
      `/api/actions/${raised.proposal}/execute?signer=${founder}`,
      actionTransactionResponseSchema,
      {},
    )
    console.log(`         grant by quorum ${await land(executed, keys.founder)}`)
    state = await delegation()
    check('both powers back', state.mask === BOTH, `mask ${state.mask}`)
    const third = await thawThroughApi(keys.carol)
    check('the key thaws again', third.mode === 'delegated', third.mode)

    // ─── A grant overtaken by a revocation ──────────────────────────────────
    const widen = await call(
      'POST',
      `/api/issuer/delegation/proposals?signer=${founder}`,
      proposeDelegationResponseSchema,
      {
        operationalKey: state.operationalKey,
        mask: BOTH | DELEGATION.SETTLE_REDEMPTION,
        termSeconds: TERM_SECONDS,
      },
    )
    await land(widen, keys.founder)
    await land(
      await call(
        'POST',
        `/api/actions/${widen.proposal}/approve?signer=${officer}`,
        actionTransactionResponseSchema,
        {},
      ),
      keys.officer,
    )
    await land(
      await call('POST', `/api/issuer/delegation/revoke?signer=${founder}`, revokeResponseSchema, {
        powers: ['THAW_HOLDER'],
      }),
      keys.founder,
    )
    const overtaken = await request(
      'POST',
      `/api/actions/${widen.proposal}/execute?signer=${founder}`,
      {},
    )
    check(
      'a grant raised before a revocation cannot undo it',
      overtaken.status === 400,
      `${overtaken.status}`,
    )

    // ─── The history, from the indexer ──────────────────────────────────────
    const deadline = Date.now() + HISTORY_TIMEOUT_MS
    state = await delegation()
    while (state.history.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      state = await delegation()
    }
    const [last, grant, all, one] = state.history
    check(
      'four changes in the history, newest first',
      state.history.length === 4,
      `${state.history.length} rows`,
    )
    check(
      'each names its path, its start and its signers',
      one?.previousMask === BOTH &&
        one.mask === DELEGATION.SET_HOLDER_STATUS &&
        one.path === 'immediate' &&
        one.signers.join() === founder &&
        all?.mask === 0 &&
        grant?.path === 'proposal' &&
        grant.proposal === raised.proposal &&
        grant.previousMask === 0 &&
        grant.signers.join() === `${founder},${officer}` &&
        last?.previousMask === BOTH &&
        last.mask === DELEGATION.SET_HOLDER_STATUS,
      state.history.map((row) => `${row.previousMask}→${row.mask} ${row.path}`).join(' · '),
    )

    // ─── Rent back for the executed grant ───────────────────────────────────
    await land(
      await call(
        'POST',
        `/api/actions/${raised.proposal}/close?signer=${founder}`,
        actionTransactionResponseSchema,
        {},
      ),
      keys.founder,
    )
    const left = (await delegation()).proposals.map((p) => p.address)
    check(
      'the executed grant closed; the overtaken one waits for its term',
      !left.includes(raised.proposal) && left.includes(widen.proposal),
      `${left.length} left`,
    )

    const failed = checks.filter((c) => !c.ok).length
    console.log(`\nT035:    ${checks.length - failed} of ${checks.length} checks passed`)
    return failed === 0 ? 0 : 1
  } finally {
    await session.close()
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error)
  return 2
})
