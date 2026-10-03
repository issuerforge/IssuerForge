// SC-006 measured: a token's journal, exported by the api, checked by the
// independent verifier against the chain (T033).
//
// The run gives the token a short compliance history on the network — every
// kind of journal line the format has, plus one instruction it does not
// carry — then exports the journal the way an auditor would receive it and
// hands the file to `tools/verify-journal` as a separate process with nothing
// but an RPC address. The verifier must confirm every line; four doctored
// copies of the same file must each fail, for their own reason. A verifier
// that passes everything would otherwise look exactly like a clean journal.
//
//   node --env-file=.env tools/demo/src/journal.ts \
//     --rpc https://api.devnet.solana.com --payer ~/.config/solana/id.json \
//     --api http://127.0.0.1:8787 --out <dir>
//
// The api must run with `RUN_WORKER=true`: the journal is the indexer's
// mirror, and the run waits for it to catch up with the last action.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  actionProposalPda,
  buildApproveAction,
  buildChangeCirculation,
  buildFreezeHolder,
  buildProposeAction,
  buildSeize,
  buildSetDelegation,
  buildSetPolicy,
  buildTransfer,
  buildUnfreezeHolder,
  type ProposedActionInput,
  type TxPlan,
} from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { DELEGATION, ISSUER_HEADER } from '@forge/shared/api'
import type { JournalManifest } from '@forge/shared/journal'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { createContext, type DemoContext, fund, keypairFromBase58, loadKeypair } from './context.ts'
import { ataOf, onboard } from './holders.ts'
import { issueToken } from './issuance.ts'
import { createIssuer } from './issuer.ts'
import { sign, submitPlan } from './send.ts'
import { openApiSession, required } from './session.ts'

const POLICY: PolicyRules = {
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 24 * 3600 },
}

/** Version 2 tightens the transfer limit — a policy change with a case, as FR-017 wants. */
const POLICY_V2: PolicyRules = { ...POLICY, transferLimit: '40000000' }

const VERIFIER = resolve(import.meta.dirname, '../../verify-journal/src/main.ts')

function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

/** The shortest term the program accepts; the proposal executes as soon as the quorum is in. */
const TERM_SECONDS = 3600

const nonce = (): bigint => BigInt(Math.floor(Math.random() * 2 ** 48))

/**
 * Lands a transfer the rules refuse. Preflight would stop it before the
 * ledger, and a refusal that never reached the ledger is not a journal line
 * (T031) — so it is sent past preflight, and the failure is the expected
 * outcome, read back by number.
 */
async function landRefusal(
  context: DemoContext,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<{ signature: string; custom: number | null }> {
  const { connection } = context
  const transaction = await sign(connection, plan, signers)
  const signature = await connection.sendTransaction(transaction, { skipPreflight: true })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  type Failure = { InstructionError?: [number, unknown] }
  let err: Failure | null
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    err = confirmation.value.err as Failure | null
  } catch (thrown) {
    // web3.js reports a failed transaction two ways: as `value.err` when the
    // socket answers first, and by rejecting with the bare error when its
    // status poll does. Both are the refusal this function is waiting for.
    if (typeof thrown !== 'object' || thrown === null || !('InstructionError' in thrown)) {
      throw thrown
    }
    err = thrown as Failure
  }
  if (err === null) throw new Error(`${signature}: the transfer went through`)
  const detail = err.InstructionError?.[1] as { Custom?: number } | undefined
  return { signature, custom: detail?.Custom ?? null }
}

interface Step {
  readonly name: string
  readonly signature: string
}

/** A quorum action: raised by the founder, approved by the officer, executed with both named. */
async function byQuorum(
  context: DemoContext,
  issuerId: PublicKey,
  mint: PublicKey,
  action: ProposedActionInput,
  execute: (proposal: PublicKey, approvers: PublicKey[]) => Promise<TxPlan>,
): Promise<string> {
  const { keys, connection, program } = context
  const n = nonce()
  const proposal = actionProposalPda(mint, n)
  await submitPlan(
    connection,
    await buildProposeAction(program, {
      issuerId,
      mint,
      nonce: n,
      termSeconds: TERM_SECONDS,
      action,
      payer: keys.founder.publicKey,
      proposer: keys.founder.publicKey,
    }),
    [keys.founder],
  )
  await submitPlan(
    connection,
    await buildApproveAction(program, { issuerId, proposal, approver: keys.officer.publicKey }),
    [keys.officer],
  )
  const plan = await execute(proposal, [keys.founder.publicKey, keys.officer.publicKey])
  return (await submitPlan(connection, plan, [keys.founder])).signature
}

async function history(
  context: DemoContext,
  issuerId: PublicKey,
  mint: PublicKey,
): Promise<Step[]> {
  const { keys, connection, program } = context
  const steps: Step[] = []
  const step = (name: string, signature: string) => {
    steps.push({ name, signature })
    console.log(`  ${name.padEnd(28)} ${signature}`)
  }
  const founder = keys.founder.publicKey
  const officer = keys.officer.publicKey
  const alice = keys.alice.publicKey
  const aliceAta = ataOf(mint, alice)
  const transfer = (recipient: PublicKey, amount: bigint) =>
    buildTransfer(connection, { mint, owner: founder, recipient, amount, decimals: 2 })

  for (const [holder, jurisdiction] of [
    [keys.alice, 'NG'],
    [keys.bob, 'GH'],
  ] as const) {
    const { thawed } = await onboard(context, mint, issuerId, holder, {
      tier: 2,
      jurisdiction,
      denied: false,
      expiresAt: 0n,
    })
    step(`thaw ${jurisdiction}`, thawed.signature)
  }

  step(
    'transfer',
    (await submitPlan(connection, await transfer(alice, 10_000n), [keys.founder])).signature,
  )
  const overLimit = await landRefusal(context, await transfer(alice, 50_000_001n), [keys.founder])
  step(`refusal ${overLimit.custom}`, overLimit.signature)

  const reason = { code: 4, caseRef: 'FIU-NG/2026/004117' }
  const frozen = await submitPlan(
    connection,
    await buildFreezeHolder(program, {
      issuerId,
      mint,
      tokenAccount: aliceAta,
      payer: founder,
      officer,
      reason,
    }),
    [keys.founder, keys.officer],
  )
  step('freeze', frozen.signature)
  const toFrozen = await landRefusal(context, await transfer(alice, 1_000n), [keys.founder])
  step(`refusal ${toFrozen.custom}`, toFrozen.signature)
  const unfrozen = await submitPlan(
    connection,
    await buildUnfreezeHolder(program, {
      issuerId,
      mint,
      tokenAccount: aliceAta,
      rentRecipient: founder,
      officer,
      reason: { code: 9, caseRef: 'FIU-NG/2026/004117/closed' },
    }),
    [keys.officer],
  )
  step('unfreeze', unfrozen.signature)

  const seizure = { code: 4, caseRef: 'COURT-LAG/2026/118' }
  step(
    'seize',
    await byQuorum(
      context,
      issuerId,
      mint,
      { kind: 'seize', tokenAccount: aliceAta, amount: 500n, reason: seizure },
      (proposal, approvers) =>
        buildSeize(program, {
          issuerId,
          mint,
          proposal,
          tokenAccount: aliceAta,
          amount: 500n,
          reason: seizure,
          approvers,
          payer: founder,
        }),
    ),
  )

  const incident = { code: 9, caseRef: 'INC-2026-0412' }
  for (const direction of ['pause', 'resume'] as const) {
    step(
      direction,
      await byQuorum(
        context,
        issuerId,
        mint,
        { kind: direction, reason: incident },
        (proposal, approvers) =>
          buildChangeCirculation(program, {
            direction,
            issuerId,
            mint,
            proposal,
            reason: incident,
            approvers,
            payer: founder,
          }),
      ),
    )
    if (direction === 'pause') {
      const paused = await landRefusal(context, await transfer(keys.bob.publicKey, 1_000n), [
        keys.founder,
      ])
      step(`refusal ${paused.custom}`, paused.signature)
    }
  }

  const policy = await submitPlan(
    connection,
    await buildSetPolicy(program, {
      issuerId,
      mint,
      version: 2,
      policy: POLICY_V2,
      reason: { code: 12, caseRef: 'POLICY/2026/0007' },
      payer: founder,
      quorum: { kind: 'immediate', signers: [founder, officer] },
    }),
    [keys.founder, keys.officer],
  )
  step('set_policy', policy.signature)

  // Not a journal line in format v1: the verifier must name it, not count it.
  const narrowed = await submitPlan(
    connection,
    await buildSetDelegation(program, {
      issuerId,
      operationalKey: keys.operational.publicKey,
      mask: DELEGATION.THAW_HOLDER,
      payer: founder,
      quorum: { kind: 'immediate', signers: [founder] },
    }),
    [keys.founder],
  )
  step('set_delegation (unjournalled)', narrowed.signature)
  return steps
}

// ─── Export and verification ─────────────────────────────────────────────────

const EXPORT_TIMEOUT_MS = 180_000
const POLL_MS = 3_000

/** Polls the export until the indexer has read past the last action. */
async function exportJournal(
  api: string,
  accessToken: string,
  issuerId: string,
  mint: string,
  lastSlot: number,
): Promise<string> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS
  for (;;) {
    const response = await fetch(`${api}/api/tokens/${mint}/journal`, {
      headers: { authorization: `Bearer ${accessToken}`, [ISSUER_HEADER]: issuerId },
    })
    if (!response.ok) throw new Error(`export refused: ${response.status} ${await response.text()}`)
    const text = await response.text()
    const manifest = JSON.parse(text.slice(0, text.indexOf('\n'))) as JournalManifest
    if (manifest.toSlot >= lastSlot) return text
    if (Date.now() >= deadline) {
      throw new Error(
        `the journal reached slot ${manifest.toSlot}, the history ended at ${lastSlot}`,
      )
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

interface Verdict {
  readonly passed: boolean
  readonly lines: number
  readonly confirmed: number
  readonly unconfirmed: unknown[]
  readonly mismatched: unknown[]
  readonly missing: unknown[]
  readonly problems: string[]
  readonly unjournalled: { instruction: string }[]
}

/** The verifier as an auditor runs it: another process, a file and an RPC address. */
async function runVerifier(file: string, rpc: string): Promise<{ code: number; verdict: Verdict }> {
  const run = promisify(execFile)
  try {
    const { stdout } = await run(process.execPath, [VERIFIER, file, '--rpc', rpc, '--json'], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, verdict: JSON.parse(stdout) as Verdict }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    if (failed.code === 1 && failed.stdout) {
      return { code: 1, verdict: JSON.parse(failed.stdout) as Verdict }
    }
    throw new Error(`the verifier did not run: ${failed.stderr ?? String(error)}`)
  }
}

/** Four ways a journal is falsified. Each must fail, and for its own reason. */
function doctored(text: string): Record<string, string> {
  const lines = text.trimEnd().split('\n')
  const manifest = JSON.parse(lines[0] as string) as JournalManifest
  const events = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>)
  const write = (m: JournalManifest, e: readonly object[]) =>
    `${[m, ...e].map((line) => JSON.stringify(line)).join('\n')}\n`

  const transfer = events.findIndex((e) => e.kind === 'transfer')
  const seize = events.findIndex((e) => e.action === 'seize')
  return {
    'amount edited': write(
      manifest,
      events.map((e, i) =>
        i === transfer ? { ...e, amount: String(BigInt(e.amount as string) + 1n) } : e,
      ),
    ),
    'seizure removed, count lowered': write(
      { ...manifest, count: manifest.count - 1 },
      events.filter((_, i) => i !== seize),
    ),
    'line invented': write({ ...manifest, count: manifest.count + 1 }, [
      ...events,
      { ...events[transfer], signature: `${String(events[transfer]?.signature).slice(0, -4)}AAAA` },
    ]),
    truncated: `${lines.slice(0, -2).join('\n')}\n`,
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const rpc = option(argv, '--rpc') ?? 'https://api.devnet.solana.com'
  const api = (option(argv, '--api') ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const out = resolve(option(argv, '--out') ?? 'journal-run')
  const payerPath = option(argv, '--payer')
  if (payerPath === undefined) throw new Error('--payer is required: the run spends real SOL')

  const context = createContext(rpc, {
    operational: keypairFromBase58(required('OPERATIONAL_SECRET_KEY')),
  })
  const { keys, connection } = context
  const payer = loadKeypair(payerPath)
  await fund(connection, keys.founder.publicKey, 0.15, payer)
  await fund(connection, keys.officer.publicKey, 0.02, payer)
  await fund(connection, keys.operational.publicKey, 0.02, payer)

  const issuer = await createIssuer(context)
  console.log(`issuer:  ${issuer.issuerId.toBase58()}`)
  const session = await openApiSession(context, issuer.issuerId, api)
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
    console.log(`mint:    ${mint.toBase58()}`)

    const steps = await history(context, issuer.issuerId, mint)
    const last = steps.at(-1) as Step
    const landed = await connection.getTransaction(last.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    const lastSlot = landed?.slot ?? (await connection.getSlot('confirmed'))

    // The journal reads up to the indexer's cursor minus one (T032): the last
    // transaction of the program is the cursor itself and stays outside the
    // export until a later one moves it. One more transfer does that; it lands
    // past the window the run waits for, so the file does not depend on it.
    await submitPlan(
      connection,
      await buildTransfer(connection, {
        mint,
        owner: keys.founder.publicKey,
        recipient: keys.alice.publicKey,
        amount: 1n,
        decimals: 2,
      }),
      [keys.founder],
    )

    const text = await exportJournal(
      api,
      session.login.accessToken,
      issuer.issuerId.toBase58(),
      mint.toBase58(),
      lastSlot,
    )
    await mkdir(out, { recursive: true })
    const original = join(out, 'journal.ndjson')
    await writeFile(original, text)
    console.log(`export:  ${original} · ${text.trimEnd().split('\n').length - 1} lines`)

    // The verifier reads finalized history only; wait for the window to get there.
    const manifest = JSON.parse(text.slice(0, text.indexOf('\n'))) as JournalManifest
    while ((await connection.getSlot('finalized')) < manifest.toSlot) {
      await new Promise((r) => setTimeout(r, POLL_MS))
    }

    const honest = await runVerifier(original, rpc)
    const v = honest.verdict
    console.log(
      `\nverify:  ${v.passed ? 'PASS' : 'FAIL'} · ${v.confirmed} of ${v.lines} confirmed · ` +
        `unconfirmed ${v.unconfirmed.length} · mismatched ${v.mismatched.length} · missing ${v.missing.length}` +
        ` · unjournalled ${v.unjournalled.map((i) => i.instruction).join(', ') || 'none'}`,
    )
    for (const problem of v.problems) console.log(`         problem: ${problem}`)

    let caught = 0
    const copies = Object.entries(doctored(text))
    for (const [name, body] of copies) {
      const path = join(out, `doctored-${name.replaceAll(/[^a-z]+/g, '-')}.ndjson`)
      await writeFile(path, body)
      const { verdict } = await runVerifier(path, rpc)
      if (!verdict.passed) caught += 1
      console.log(
        `  ${verdict.passed ? 'MISSED' : 'caught'} ${name.padEnd(32)} ` +
          `mismatched ${verdict.mismatched.length} · unconfirmed ${verdict.unconfirmed.length} · ` +
          `missing ${verdict.missing.length} · problems ${verdict.problems.length}`,
      )
    }
    const share = v.lines === 0 ? 0 : (v.unconfirmed.length + v.mismatched.length) / v.lines
    console.log(
      `\nSC-006:  unconfirmed share ${share} (budget 0) · doctored copies caught ${caught} of ${copies.length}`,
    )
    return v.passed && caught === copies.length ? 0 : 1
  } finally {
    await session.close()
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error)
  return 2
})
