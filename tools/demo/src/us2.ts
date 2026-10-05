// The US2 measurements on devnet (T036): SC-004, SC-013, SC-012.
//
//   node --env-file=.env tools/demo/src/us2.ts \
//     --rpc https://api.devnet.solana.com --payer ~/.config/solana/id.json \
//     --api http://127.0.0.1:8787
//
// and an hour later, when the single-signature proposals have lapsed:
//
//   node --env-file=.env tools/demo/src/us2.ts --close <run file> --payer …
//
// **SC-004** — from the officer's click to the holder's refused transfer. The
// clock starts at the api request, so assembly, signing, sending and
// confirmation are all inside it; it stops when a transfer the holder keeps
// sending once a second is seen refused in a block. Ten freezes and three
// seizures, each preceded by passing transfers so that the refusal is the
// action's and not the pump's; every transfer landing after the action's slot
// must be refused.
//
// **SC-013** — five kinds of quorum action, ten proposals each, every one
// holding exactly one approval. Each is executed straight at the program with
// every list a client could forge (the proposer alone, the second seat named
// but unsigned, the second seat signing the execution instead of the
// proposal, the proposer twice, the platform's key as the second), and once
// through the api. Policy and delegation also have an immediate path, tried
// with one real signature and a forged second. The program counts the
// approvals it stored, not the accounts it is handed, so every one of these
// must refuse; the state is read back before a single control proposal per
// kind takes its second signature and executes — the proof the attempts were
// well-formed.
//
// **SC-012** — the platform's key, holding every power it can be given, tries
// what matters three ways: straight at our program (the T030 mollusk list,
// now on chain), straight at Token-2022 as if it were the mint's authorities
// (minting, thawing, freezing, burning, moving, pausing, re-pointing the hook,
// taking the mint's or a holder's account), and through the api. Our program
// has no `mint` and no `set_roles` yet (T038 and later): emission is measured
// as the raw `mint_to` here, and must be measured again when the instruction
// exists.
//
// Every attempt on chain skips preflight (`landed.ts`): a refusal is a failed
// transaction in a block, with a signature in the report.
//
// The api must run with `RUN_WORKER=true`.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actionTransactionResponseSchema,
  proposalDetailResponseSchema,
  proposeActionResponseSchema,
} from '@forge/api/contracts/actions'
import {
  complianceSummarySchema,
  officerTransactionResponseSchema,
  tokenListResponseSchema,
} from '@forge/api/contracts/compliance'
import {
  delegationResponseSchema,
  proposeDelegationResponseSchema,
} from '@forge/api/contracts/delegation'
import {
  buildApproveAction,
  buildChangeCirculation,
  buildCloseActionProposal,
  buildFreezeHolder,
  buildProposeAction,
  buildProposeDelegation,
  buildSeize,
  buildSetDelegation,
  buildSetPolicy,
  buildTransfer,
  createForgeProgram,
  fromBase64,
  issuerConfigPda,
  type ProposedActionInput,
  seizureVaultAddress,
  type TxPlan,
  tokenConfigPda,
} from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { DELEGATION, DELEGATION_ALL, ISSUER_HEADER, ROLE } from '@forge/shared/api'
import {
  AuthorityType,
  createBurnCheckedInstruction,
  createFreezeAccountInstruction,
  createMintToInstruction,
  createPauseInstruction,
  createSetAuthorityInstruction,
  createThawAccountInstruction,
  createTransferCheckedWithTransferHookInstruction,
  createUpdateTransferHookInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js'
import { createContext, fund, keypairFromBase58, loadKeypair, unpacedFetch } from './context.ts'
import { ataOf, createAta, onboard } from './holders.ts'
import { issueToken } from './issuance.ts'
import { createIssuer } from './issuer.ts'
import { type Landed, landAttempt } from './landed.ts'
import { type Shot, TransferPump } from './pump.ts'
import { send, submit, submitPlan } from './send.ts'
import { openApiSession, required } from './session.ts'

const POLICY: PolicyRules = {
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 24 * 3600 },
}
/** What every policy proposal asks for: a tighter per-transfer limit. */
const NEXT_POLICY: PolicyRules = { ...POLICY, transferLimit: '40000000' }

const DECIMALS = 2
const SUPPLY = 2_500_000_000n
const TO_ALICE = 1_000_000n
const TO_BOB = 1_000_000n
/** What each SC-004 seizure takes from Bob. */
const SEIZED = 100_000n
/** What each SC-013 seizure proposal would take. */
const PROPOSED_SEIZURE = 1n

const BUDGET_MS = 30_000
const FREEZE_CYCLES = 10
const SEIZE_CYCLES = 3
/** Transfers that must be sent and refused after each action took effect. */
const AFTER_EFFECT = 5
const PROPOSALS_PER_KIND = 10
const IMMEDIATE_ROUNDS = 2
const TERM_SECONDS = 3600

const REASON = { code: 4, caseRef: 'FIU-NG/2026/T036' }
const INCIDENT = { code: 8, caseRef: 'INC-2026-T036' }

function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/** What `--close` needs an hour later: the founder signs the closes and gets the rent. */
interface RunFile {
  readonly issuerId: string
  readonly mint: string | null
  readonly founderSecret: number[]
  readonly proposals: string[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** The same instruction with `wallets` turned into signers wherever they appear. */
function signedBy(
  instruction: TransactionInstruction,
  wallets: readonly PublicKey[],
): TransactionInstruction {
  instruction.keys = instruction.keys.map((key) =>
    wallets.some((wallet) => wallet.equals(key.pubkey)) ? { ...key, isSigner: true } : key,
  )
  return instruction
}

/** The same instruction with `wallets` stripped of their signer flag. */
function unsignedFor(
  instruction: TransactionInstruction,
  wallets: readonly PublicKey[],
): TransactionInstruction {
  instruction.keys = instruction.keys.map((key) =>
    wallets.some((wallet) => wallet.equals(key.pubkey)) ? { ...key, isSigner: false } : key,
  )
  return instruction
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const rpc = option(argv, '--rpc') ?? 'https://api.devnet.solana.com'
  const base = (option(argv, '--api') ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const payerPath = option(argv, '--payer')
  if (payerPath === undefined) throw new Error('--payer is required: the run spends real SOL')
  const closing = option(argv, '--close')
  if (closing !== undefined) return await closeRun(closing, rpc, loadKeypair(payerPath))

  const context = createContext(rpc, {
    operational: keypairFromBase58(required('OPERATIONAL_SECRET_KEY')),
  })
  const { keys, connection, program } = context
  const payer = loadKeypair(payerPath)
  await fund(connection, keys.founder.publicKey, 0.25, payer)
  await fund(connection, keys.officer.publicKey, 0.05, payer)
  await fund(connection, keys.attestor.publicKey, 0.01, payer)
  await fund(connection, keys.operational.publicKey, 0.03, payer)

  const issuer = await createIssuer(context)
  const issuerId = issuer.issuerId.toBase58()
  console.log(`issuer:  ${issuerId}`)

  // Written before anything is raised: a run that dies halfway must still be
  // able to give its rent back.
  const runDir = option(argv, '--run-dir') ?? join(tmpdir(), 'issuerforge-us2')
  mkdirSync(runDir, { recursive: true })
  const runPath = join(runDir, `${issuerId}.json`)
  const proposals: string[] = []
  let mintAddress: string | null = null
  const save = () => {
    const file: RunFile = {
      issuerId,
      mint: mintAddress,
      founderSecret: Array.from(keys.founder.secretKey),
      proposals,
    }
    writeFileSync(runPath, `${JSON.stringify(file, null, 2)}\n`)
  }
  save()
  console.log(`run:     ${runPath}`)

  const session = await openApiSession(context, issuer.issuerId, base)

  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${detail}`)
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
    for (let attempt = 0; ; attempt += 1) {
      const response = await request(method, path, body)
      const payload: unknown = await response.json()
      if (response.ok) return schema.parse(payload)
      // The api reads the chain through the same public node, IP and methods
      // as its indexer and this run, and passes a node's 429 on as a 500
      // (a debt of the api's own). A read changes nothing, so it waits the
      // burst out; a write is never repeated.
      if (method !== 'GET' || response.status < 500 || attempt === 3) {
        throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`)
      }
      await sleep(10_000)
    }
  }

  /** Signs what the api assembled with the wallet it named. */
  function signAssembled(
    assembled: { transaction: { base64: string; signers: string[] } },
    wallet: Keypair,
  ) {
    if (assembled.transaction.signers.join() !== wallet.publicKey.toBase58()) {
      throw new Error(`the api named ${assembled.transaction.signers.join()} to sign`)
    }
    const transaction = fromBase64(assembled.transaction.base64)
    transaction.sign([wallet])
    return transaction
  }

  async function land(
    assembled: { transaction: { base64: string; signers: string[] } },
    wallet: Keypair,
  ): Promise<string> {
    return (await send(connection, signAssembled(assembled, wallet))).signature
  }

  const founder = keys.founder.publicKey
  const officer = keys.officer.publicKey
  const operational = keys.operational.publicKey

  try {
    const issuance = await issueToken(context, {
      issuerId: issuer.issuerId,
      tokenIndex: 0,
      decimals: DECIMALS,
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
    const mint = issuance.addresses.mint
    mintAddress = mint.toBase58()
    save()
    console.log(`mint:    ${mintAddress}`)

    const status = { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: 0n }
    await onboard(context, mint, issuer.issuerId, keys.alice, status)
    await onboard(context, mint, issuer.issuerId, keys.bob, status)
    // Never let in: its account exists, frozen by `DefaultAccountState`.
    await createAta(context, mint, keys.stranger.publicKey)
    for (const [holder, amount] of [
      [keys.alice, TO_ALICE],
      [keys.bob, TO_BOB],
    ] as const) {
      await submitPlan(
        connection,
        await buildTransfer(connection, {
          mint,
          owner: founder,
          recipient: holder.publicKey,
          amount,
          decimals: DECIMALS,
        }),
        [keys.founder],
      )
    }
    const aliceAccount = ataOf(mint, keys.alice.publicKey)
    const bobAccount = ataOf(mint, keys.bob.publicKey)
    const strangerAccount = ataOf(mint, keys.stranger.publicKey)
    const balanceOf = async (account: PublicKey) =>
      BigInt((await connection.getTokenAccountBalance(account)).value.amount)

    const summary = () =>
      call('GET', `/api/tokens/${mintAddress}/compliance`, complianceSummarySchema)
    const listing = async () => {
      const { tokens } = await call('GET', '/api/tokens', tokenListResponseSchema)
      const token = tokens.find((t) => t.mint === mintAddress)
      if (token === undefined) throw new Error('the token is not listed')
      return token
    }
    const delegation = () => call('GET', '/api/issuer/delegation', delegationResponseSchema)

    /** One proposal from the console, landed with the founder's one signature. */
    async function raise(action: unknown): Promise<PublicKey> {
      const raised = await call(
        'POST',
        `/api/tokens/${mintAddress}/actions?signer=${founder.toBase58()}`,
        proposeActionResponseSchema,
        { action, termSeconds: TERM_SECONDS },
      )
      await land(raised, keys.founder)
      proposals.push(raised.proposal)
      save()
      return new PublicKey(raised.proposal)
    }

    async function raiseGrant(): Promise<PublicKey> {
      const raised = await call(
        'POST',
        `/api/issuer/delegation/proposals?signer=${founder.toBase58()}`,
        proposeDelegationResponseSchema,
        { operationalKey: operational.toBase58(), mask: DELEGATION_ALL, termSeconds: TERM_SECONDS },
      )
      await land(raised, keys.founder)
      proposals.push(raised.proposal)
      save()
      return new PublicKey(raised.proposal)
    }

    /** The second signature and the execution, both through the console's path. */
    async function complete(proposal: PublicKey): Promise<string> {
      const approved = await call(
        'POST',
        `/api/actions/${proposal.toBase58()}/approve?signer=${officer.toBase58()}`,
        actionTransactionResponseSchema,
        {},
      )
      await land(approved, keys.officer)
      const executed = await call(
        'POST',
        `/api/actions/${proposal.toBase58()}/execute?signer=${founder.toBase58()}`,
        actionTransactionResponseSchema,
        {},
      )
      return await land(executed, keys.founder)
    }

    async function closeExecuted(proposal: PublicKey): Promise<void> {
      const closed = await call(
        'POST',
        `/api/actions/${proposal.toBase58()}/close?signer=${founder.toBase58()}`,
        actionTransactionResponseSchema,
        {},
      )
      await land(closed, keys.founder)
      proposals.splice(proposals.indexOf(proposal.toBase58()), 1)
      save()
    }

    // ═══ SC-004 ═════════════════════════════════════════════════════════════
    // `--skip-sc004`: the freeze cycles take half an hour on the public node,
    // and a rerun of the quorum sections alone should not repeat them.
    if (!argv.includes('--skip-sc004')) {
      console.log('\nSC-004 — from the console to the refused transfer')
      const pump = new TransferPump(rpc)
      const cycles: {
        kind: 'freeze' | 'seize'
        label: string
        t0: number
        /** The api's answer: assembly, including its own reads of the chain. */
        apiMs: number
        /** The node accepted the signed transaction (preflight included). */
        sentMs: number
        effectMs: number
        refusalMs: number
        fromSlot: number
        untilSlot: number
      }[] = []

      /** Sends a console transaction off the pump's connection and times its confirmation. */
      async function landTimed(
        assembled: { transaction: { base64: string; signers: string[] } },
        wallet: Keypair,
      ) {
        const assembledAt = Date.now()
        const signature = await pump.connection.sendRawTransaction(
          signAssembled(assembled, wallet).serialize(),
          { preflightCommitment: 'confirmed' },
        )
        const acceptedAt = Date.now()
        const confirmed = await pump.confirmed(signature)
        if (confirmed.error !== null) {
          throw new Error(`${signature} failed: ${JSON.stringify(confirmed.error)}`)
        }
        return { signature, assembledAt, acceptedAt, ...confirmed }
      }

      /**
       * Waits until at least `count` shots of `label` were sent after `since`
       * and none of them is still in flight. With one shot a second that
       * moment comes late, so a window holds far more than `count` refusals —
       * the measured run had ~87 a freeze; more attempts, not fewer.
       */
      async function settled(label: string, since: number, count: number): Promise<void> {
        for (;;) {
          const after = pump.shots.filter((s) => s.label === label && s.sentAt >= since)
          if (after.length >= count && after.every((s) => s.state !== 'pending')) return
          await sleep(250)
        }
      }

      const transferPlan = await buildTransfer(connection, {
        mint,
        owner: keys.alice.publicKey,
        recipient: keys.bob.publicKey,
        amount: 1n,
        decimals: DECIMALS,
      })
      pump.start()

      try {
        for (let cycle = 1; cycle <= FREEZE_CYCLES; cycle += 1) {
          const label = `freeze-${cycle}`
          pump.aim({ label, plan: transferPlan, feePayer: keys.founder, signers: [keys.alice] })
          await pump.passes(2, Date.now())

          const t0 = Date.now()
          const freezing = await call(
            'POST',
            `/api/tokens/${mintAddress}/freezes?signer=${officer.toBase58()}`,
            officerTransactionResponseSchema,
            { wallet: keys.alice.publicKey.toBase58(), reason: REASON },
          )
          const effect = await landTimed(freezing, keys.officer)
          const refusal = await pump.firstRefusal(t0)
          await settled(label, effect.at, AFTER_EFFECT)

          const lifting = await call(
            'POST',
            `/api/tokens/${mintAddress}/freezes/${aliceAccount.toBase58()}/unfreeze?signer=${officer.toBase58()}`,
            officerTransactionResponseSchema,
            { reason: { code: 9, caseRef: `${REASON.caseRef}/closed` } },
          )
          const lifted = await landTimed(lifting, keys.officer)
          cycles.push({
            kind: 'freeze',
            label,
            t0,
            apiMs: effect.assembledAt - t0,
            sentMs: effect.acceptedAt - t0,
            effectMs: effect.at - t0,
            refusalMs: (refusal.observedAt ?? Date.now()) - t0,
            fromSlot: effect.slot,
            untilSlot: lifted.slot,
          })
          console.log(
            `         ${label}: api ${seconds(effect.assembledAt - t0)} · sent ${seconds(effect.acceptedAt - t0)} · in force ${seconds(effect.at - t0)} · refused ${seconds((refusal.observedAt ?? 0) - t0)} · slot ${effect.slot}`,
          )
        }

        for (let cycle = 1; cycle <= SEIZE_CYCLES; cycle += 1) {
          const label = `seize-${cycle}`
          const proposal = await raise({
            kind: 'seize',
            tokenAccount: bobAccount.toBase58(),
            amount: SEIZED.toString(),
            reason: REASON,
          })
          const approved = await call(
            'POST',
            `/api/actions/${proposal.toBase58()}/approve?signer=${officer.toBase58()}`,
            actionTransactionResponseSchema,
            {},
          )
          await land(approved, keys.officer)

          // Bob moves to himself exactly one unit more than a seizure leaves
          // him: it passes while the money is his and fails the moment it is
          // not, without ever draining what the seizure must take.
          await pump.hold()
          const balance = await balanceOf(bobAccount)
          pump.aim({
            label,
            plan: await buildTransfer(connection, {
              mint,
              owner: keys.bob.publicKey,
              recipient: keys.bob.publicKey,
              amount: balance - SEIZED + 1n,
              decimals: DECIMALS,
            }),
            feePayer: keys.founder,
            signers: [keys.bob],
          })
          await pump.passes(2, Date.now())

          const t0 = Date.now()
          const executing = await call(
            'POST',
            `/api/actions/${proposal.toBase58()}/execute?signer=${founder.toBase58()}`,
            actionTransactionResponseSchema,
            {},
          )
          const effect = await landTimed(executing, keys.founder)
          const refusal = await pump.firstRefusal(t0)
          await settled(label, effect.at, AFTER_EFFECT)
          cycles.push({
            kind: 'seize',
            label,
            t0,
            apiMs: effect.assembledAt - t0,
            sentMs: effect.acceptedAt - t0,
            effectMs: effect.at - t0,
            refusalMs: (refusal.observedAt ?? Date.now()) - t0,
            fromSlot: effect.slot,
            untilSlot: Number.MAX_SAFE_INTEGER,
          })
          console.log(
            `         ${label}: api ${seconds(effect.assembledAt - t0)} · sent ${seconds(effect.acceptedAt - t0)} · in force ${seconds(effect.at - t0)} · refused ${seconds((refusal.observedAt ?? 0) - t0)} · slot ${effect.slot}`,
          )
          await closeExecuted(proposal)
        }
      } finally {
        await pump.stop()
      }

      // A transfer counts against an action if it landed after the action's
      // slot and before it was lifted; one in the same slot may have been
      // ordered either way and is reported, not judged.
      const judged = cycles.map((cycle) => {
        const own = pump.shots.filter((s) => s.label === cycle.label)
        const after = own.filter(
          (s) => s.slot !== undefined && s.slot > cycle.fromSlot && s.slot < cycle.untilSlot,
        )
        return {
          ...cycle,
          after,
          sameSlot: own.filter((s) => s.slot === cycle.fromSlot).length,
          passedAfter: after.filter((s) => s.state === 'passed'),
        }
      })
      const codeOfShot = (shot: Shot) =>
        (shot.error as { InstructionError?: [number, { Custom?: number }] } | undefined)
          ?.InstructionError?.[1]?.Custom
      for (const kind of ['freeze', 'seize'] as const) {
        const of = judged.filter((c) => c.kind === kind)
        const refusals = of.map((c) => c.refusalMs).sort((a, b) => a - b)
        const expected = kind === 'freeze' ? 17 : 1
        const codes = new Set(of.flatMap((c) => c.after.map(codeOfShot)))
        check(
          `${kind}: refused within ${BUDGET_MS / 1000} s, every cycle`,
          refusals.every((ms) => ms <= BUDGET_MS),
          `${of.length} cycles · p50 ${seconds(refusals[Math.floor(refusals.length / 2)] ?? 0)} · max ${seconds(refusals.at(-1) ?? 0)}`,
        )
        const after = of.reduce((n, c) => n + c.after.length, 0)
        const passed = of.reduce((n, c) => n + c.passedAfter.length, 0)
        check(
          `${kind}: no transfer passes after it took effect`,
          passed === 0 && of.every((c) => c.after.length >= AFTER_EFFECT),
          `${after} after · ${passed} passed · codes ${[...codes].join(',')} (expect ${expected}) · ${of.reduce((n, c) => n + c.sameSlot, 0)} in the same slot`,
        )
        check(
          `${kind}: refused by the reason the action set`,
          codes.size === 1 && codes.has(expected),
          kind === 'freeze' ? 'AccountFrozen' : 'InsufficientFunds',
        )
      }
      const dropped = pump.shots.filter((s) => s.state === 'dropped').length
      console.log(`         pump: ${pump.shots.length} transfers sent, ${dropped} never landed`)
    }

    // ═══ SC-013 ═════════════════════════════════════════════════════════════
    console.log('\nSC-013 — one signature of two moves nothing')
    const proposer = [founder]

    type Vector = {
      readonly name: string
      readonly listed: readonly PublicKey[]
      readonly cosigner: Keypair | undefined
      readonly expected: readonly string[]
    }
    // A forged list is refused either for not matching the stored approvals
    // or for those approvals falling short, whichever the instruction checks
    // first (`set_policy` matches the list before counting, the others count
    // first); both say the stored proposal, not the list, decides. The honest
    // list can only fall short.
    const forged = ['approversNotListed', 'quorumNotReached']
    const deferred: readonly Vector[] = [
      {
        name: 'the proposer alone',
        listed: proposer,
        cosigner: undefined,
        expected: ['quorumNotReached'],
      },
      {
        name: 'the second seat named, unsigned',
        listed: [founder, officer],
        cosigner: undefined,
        expected: forged,
      },
      {
        name: 'the second seat signs the execution',
        listed: [founder, officer],
        cosigner: keys.officer,
        expected: forged,
      },
      {
        name: 'the proposer twice',
        listed: [founder, founder],
        cosigner: undefined,
        expected: forged,
      },
      {
        name: 'the platform key as the second',
        listed: [founder, operational],
        cosigner: keys.operational,
        expected: forged,
      },
    ]

    type Kind = 'seize' | 'pause' | 'resume' | 'set-policy' | 'set-delegation'
    const tally = new Map<Kind, { onChain: Landed[]; api: number[]; unexpected: string[] }>()
    const attempts = (kind: Kind) => {
      let entry = tally.get(kind)
      if (entry === undefined) {
        entry = { onChain: [], api: [], unexpected: [] }
        tally.set(kind, entry)
      }
      return entry
    }
    const record = (kind: Kind, what: string, landed: Landed, expected: readonly string[]) => {
      const entry = attempts(kind)
      entry.onChain.push(landed)
      if (landed.passed || !expected.includes(landed.name ?? '')) {
        entry.unexpected.push(
          `${what}: ${landed.passed ? 'PASSED' : (landed.name ?? landed.code)} ${landed.signature}`,
        )
      }
    }

    let policyVersion = (await listing()).policyVersion

    /** The execution of `kind` on the deferred path, with the list a client chose. */
    async function execution(
      kind: Kind,
      proposal: PublicKey,
      approvers: readonly PublicKey[],
    ): Promise<TxPlan> {
      switch (kind) {
        case 'seize':
          return await buildSeize(program, {
            issuerId: issuer.issuerId,
            mint,
            proposal,
            tokenAccount: bobAccount,
            amount: PROPOSED_SEIZURE,
            reason: REASON,
            approvers,
            payer: founder,
          })
        case 'pause':
        case 'resume':
          return await buildChangeCirculation(program, {
            direction: kind,
            issuerId: issuer.issuerId,
            mint,
            proposal,
            reason: INCIDENT,
            approvers,
            payer: founder,
          })
        case 'set-policy':
          return await buildSetPolicy(program, {
            issuerId: issuer.issuerId,
            mint,
            version: policyVersion + 1,
            policy: NEXT_POLICY,
            reason: REASON,
            payer: founder,
            quorum: { kind: 'proposal', proposal, approvers },
          })
        case 'set-delegation':
          return await buildSetDelegation(program, {
            issuerId: issuer.issuerId,
            operationalKey: operational,
            mask: DELEGATION_ALL,
            payer: founder,
            quorum: { kind: 'proposal', proposal, approvers },
          })
      }
    }

    const body = (kind: Exclude<Kind, 'set-delegation'>): unknown => {
      switch (kind) {
        case 'seize':
          return {
            kind,
            tokenAccount: bobAccount.toBase58(),
            amount: PROPOSED_SEIZURE.toString(),
            reason: REASON,
          }
        case 'pause':
        case 'resume':
          return { kind, reason: INCIDENT }
        case 'set-policy':
          return { kind, policy: NEXT_POLICY, reason: REASON }
      }
    }

    /** What the action would change, read back so "no effect" is a reading, not a belief. */
    async function state(kind: Kind): Promise<string> {
      switch (kind) {
        case 'seize': {
          const totals = await summary()
          return `bob ${await balanceOf(bobAccount)} · seized ${totals.seized.amount}`
        }
        case 'pause':
        case 'resume':
          return `paused ${(await summary()).paused}`
        case 'set-policy':
          return `policy v${(await listing()).policyVersion}`
        case 'set-delegation': {
          const current = await delegation()
          return `key ${current.operationalKey.slice(0, 6)}… mask ${current.mask}`
        }
      }
    }

    async function immediateAttempts(kind: 'set-policy' | 'set-delegation'): Promise<void> {
      const vectors: {
        name: string
        signers: Keypair[]
        listed: PublicKey[]
        unsigned: PublicKey[]
        expected: string[]
      }[] = [
        {
          name: 'one signature',
          signers: [keys.founder],
          listed: [founder],
          unsigned: [],
          expected: ['quorumNotReached'],
        },
        {
          name: 'one signature listed twice',
          signers: [keys.founder],
          listed: [founder, founder],
          unsigned: [],
          expected: ['duplicateApproval'],
        },
        {
          name: 'the second seat named, unsigned',
          signers: [keys.founder],
          listed: [founder, officer],
          unsigned: [officer],
          expected: ['notAnAuthorisingSigner'],
        },
        {
          name: 'the platform key signs second',
          signers: [keys.founder, keys.operational],
          listed: [founder, operational],
          unsigned: [],
          expected: ['notAnAuthorisingSigner'],
        },
        {
          name: 'the attestor signs second',
          signers: [keys.founder, keys.attestor],
          listed: [founder, keys.attestor.publicKey],
          unsigned: [],
          expected: ['notAnAuthorisingSigner'],
        },
      ]
      for (let round = 0; round < IMMEDIATE_ROUNDS; round += 1) {
        for (const vector of vectors) {
          const plan =
            kind === 'set-policy'
              ? await buildSetPolicy(program, {
                  issuerId: issuer.issuerId,
                  mint,
                  version: policyVersion + 1,
                  policy: NEXT_POLICY,
                  reason: REASON,
                  payer: founder,
                  quorum: { kind: 'immediate', signers: vector.listed },
                })
              : await buildSetDelegation(program, {
                  issuerId: issuer.issuerId,
                  operationalKey: operational,
                  mask: DELEGATION_ALL,
                  payer: founder,
                  quorum: { kind: 'immediate', signers: vector.listed },
                })
          const instructions = plan.instructions.map((ix) => unsignedFor(ix, vector.unsigned))
          const landed = await landAttempt(connection, founder, instructions, vector.signers)
          record(kind, `immediate, ${vector.name}`, landed, vector.expected)
        }
      }
    }

    async function measureKind(kind: Kind): Promise<void> {
      const before = await state(kind)
      const raised: PublicKey[] = []
      for (let i = 0; i < PROPOSALS_PER_KIND; i += 1) {
        raised.push(kind === 'set-delegation' ? await raiseGrant() : await raise(body(kind)))
      }

      for (const proposal of raised) {
        const detail = await call(
          'GET',
          `/api/actions/${proposal.toBase58()}`,
          proposalDetailResponseSchema,
        )
        if (detail.proposal.approvals.join() !== founder.toBase58()) {
          throw new Error(`${proposal.toBase58()} holds ${detail.proposal.approvals.join()}`)
        }
        for (const vector of deferred) {
          const plan = await execution(kind, proposal, vector.listed)
          const cosigners = vector.cosigner === undefined ? [] : [vector.cosigner.publicKey]
          const instructions = plan.instructions.map((ix) => signedBy(ix, cosigners))
          const signers =
            vector.cosigner === undefined ? [keys.founder] : [keys.founder, vector.cosigner]
          record(
            kind,
            vector.name,
            await landAttempt(connection, founder, instructions, signers),
            vector.expected,
          )
        }
        const viaApi = await request(
          'POST',
          `/api/actions/${proposal.toBase58()}/execute?signer=${founder.toBase58()}`,
          {},
        )
        attempts(kind).api.push(viaApi.status)
      }
      if (kind === 'set-policy' || kind === 'set-delegation') await immediateAttempts(kind)

      const after = await state(kind)
      const entry = attempts(kind)
      check(
        `${kind}: ${entry.onChain.length} on chain, all refused for the quorum`,
        entry.onChain.length >= PROPOSALS_PER_KIND && entry.unexpected.length === 0,
        entry.unexpected.length === 0
          ? `${raised.length} proposals × ${deferred.length}${kind === 'set-policy' || kind === 'set-delegation' ? ` + ${IMMEDIATE_ROUNDS * 5} immediate` : ''}`
          : entry.unexpected.slice(0, 3).join(' | '),
      )
      check(
        `${kind}: the api refuses to assemble each before signing`,
        entry.api.length === raised.length && entry.api.every((s) => s === 400),
        `${entry.api.filter((s) => s === 400).length} of ${entry.api.length} → 400`,
      )
      check(`${kind}: no effect, read from the chain`, before === after, after)

      // The control: the same proposal with its second signature does execute.
      const control = raised[0]
      if (control === undefined) throw new Error('no proposal raised')
      console.log(`         ${kind} control ${await complete(control)}`)
      const controlled = await state(kind)
      check(`${kind}: the second signature executes it (control)`, controlled !== after, controlled)
      await closeExecuted(control)
    }

    await measureKind('seize')
    await measureKind('pause')
    await measureKind('resume')
    await measureKind('set-policy')
    policyVersion = (await listing()).policyVersion
    await measureKind('set-delegation')

    // ═══ SC-012 ═════════════════════════════════════════════════════════════
    console.log('\nSC-012 — the platform key, holding every power, moves nothing')
    const granted = await delegation()
    check(
      'the key holds every power it can be given',
      granted.operationalKey === operational.toBase58() && granted.mask === DELEGATION_ALL,
      `mask ${granted.mask}`,
    )

    const keyAttempts: {
      layer: 'program' | 'token' | 'api'
      what: string
      ok: boolean
      detail: string
    }[] = []
    const onChain = async (
      layer: 'program' | 'token',
      what: string,
      instructions: readonly TransactionInstruction[],
      signers: readonly Keypair[],
      expected: (landed: Landed) => boolean,
    ) => {
      const landed = await landAttempt(connection, operational, instructions, signers)
      const ok = !landed.passed && expected(landed)
      keyAttempts.push({
        layer,
        what,
        ok,
        detail: `${landed.passed ? 'PASSED' : (landed.name ?? landed.code)} ${landed.signature}`,
      })
    }
    const ours =
      (...names: string[]) =>
      (landed: Landed) =>
        names.includes(landed.name ?? '')
    const byToken = (landed: Landed) => landed.refusedBy === TOKEN_2022_PROGRAM_ID.toBase58()

    const successor = Keypair.generate().publicKey
    const nonce = () => randomBytes(8).readBigUInt64LE()
    const proposeAs = async (action: ProposedActionInput) =>
      (
        await buildProposeAction(program, {
          issuerId: issuer.issuerId,
          mint,
          nonce: nonce(),
          termSeconds: TERM_SECONDS,
          action,
          payer: operational,
          proposer: operational,
        })
      ).instructions
    const policyNow = async (listed: PublicKey[]) =>
      (
        await buildSetPolicy(program, {
          issuerId: issuer.issuerId,
          mint,
          version: (await listing()).policyVersion + 1,
          policy: NEXT_POLICY,
          reason: REASON,
          payer: operational,
          quorum: { kind: 'immediate', signers: listed },
        })
      ).instructions
    const delegateNow = async (key: PublicKey, mask: number, listed: PublicKey[]) =>
      (
        await buildSetDelegation(program, {
          issuerId: issuer.issuerId,
          operationalKey: key,
          mask,
          payer: operational,
          quorum: { kind: 'immediate', signers: listed },
        })
      ).instructions
    const found = async (members: { wallet: PublicKey; roles: number }[]) => {
      const issuerIdOf = Keypair.generate().publicKey
      return [
        await program.methods
          .initializeIssuer({
            issuerId: issuerIdOf,
            members,
            quorumN: 2,
            operationalKey: operational,
            delegationMask: DELEGATION.THAW_HOLDER,
          })
          .accountsPartial({
            issuerConfig: issuerConfigPda(issuerIdOf),
            payer: operational,
            founder: operational,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ]
    }

    // A live proposal an admin raised, for the key to push over or erase.
    const target = await raise({ kind: 'pause', reason: INCIDENT })
    const key = [keys.operational]
    const keyAndFounder = [keys.operational, keys.founder]
    const notASigner = ours('notAnAuthorisingSigner')

    await onChain(
      'program',
      'policy change, alone',
      await policyNow([operational]),
      key,
      notASigner,
    )
    await onChain(
      'program',
      'policy change, as the second signature',
      await policyNow([founder, operational]),
      keyAndFounder,
      notASigner,
    )
    await onChain(
      'program',
      'proposing a policy change',
      await proposeAs({
        kind: 'set-policy',
        version: (await listing()).policyVersion + 1,
        policy: NEXT_POLICY,
        reason: REASON,
      }),
      key,
      notASigner,
    )
    await onChain(
      'program',
      'proposing a seizure',
      await proposeAs({
        kind: 'seize',
        tokenAccount: aliceAccount,
        amount: TO_ALICE,
        reason: REASON,
      }),
      key,
      notASigner,
    )
    await onChain(
      'program',
      'proposing a pause',
      await proposeAs({ kind: 'pause', reason: INCIDENT }),
      key,
      notASigner,
    )
    await onChain(
      'program',
      'proposing a resumption',
      await proposeAs({ kind: 'resume', reason: INCIDENT }),
      key,
      notASigner,
    )
    await onChain(
      'program',
      'proposing its own rotation',
      (
        await buildProposeDelegation(program, {
          issuerId: issuer.issuerId,
          nonce: nonce(),
          termSeconds: TERM_SECONDS,
          operationalKey: successor,
          mask: DELEGATION_ALL,
          payer: operational,
          proposer: operational,
        })
      ).instructions,
      key,
      notASigner,
    )
    await onChain(
      'program',
      'rotating itself, alone',
      await delegateNow(successor, DELEGATION_ALL, [operational]),
      key,
      notASigner,
    )
    await onChain(
      'program',
      'rotating itself, as the second signature',
      await delegateNow(successor, DELEGATION_ALL, [founder, operational]),
      keyAndFounder,
      notASigner,
    )
    await onChain(
      'program',
      'revoking a power, as if an admin',
      await delegateNow(operational, DELEGATION_ALL & ~DELEGATION.THAW_HOLDER, [operational]),
      key,
      notASigner,
    )
    await onChain(
      'program',
      'founding an issuer it is not in',
      await found([
        { wallet: founder, roles: ROLE.ADMIN },
        { wallet: officer, roles: ROLE.COMPLIANCE },
      ]),
      key,
      ours('notAnAdmin'),
    )
    await onChain(
      'program',
      'founding an issuer with itself as an admin',
      await found([
        { wallet: operational, roles: ROLE.ADMIN },
        { wallet: founder, roles: ROLE.ADMIN },
      ]),
      key,
      ours('operationalKeyIsAMember'),
    )
    await onChain(
      'program',
      'approving an admin’s pause',
      (
        await buildApproveAction(program, {
          issuerId: issuer.issuerId,
          proposal: target,
          approver: operational,
        })
      ).instructions,
      key,
      notASigner,
    )
    await onChain(
      'program',
      'closing an admin’s proposal',
      (
        await buildCloseActionProposal(program, {
          issuerId: issuer.issuerId,
          proposal: target,
          rentRecipient: founder,
          member: operational,
        })
      ).instructions,
      key,
      notASigner,
    )
    await onChain(
      'program',
      'freezing a holder, as if the officer',
      (
        await buildFreezeHolder(program, {
          issuerId: issuer.issuerId,
          mint,
          tokenAccount: aliceAccount,
          payer: operational,
          officer: operational,
          reason: REASON,
        })
      ).instructions,
      key,
      ours('notAnOfficer', 'notAnAuthorisingSigner'),
    )

    // Straight at Token-2022: the key presenting itself as each authority
    // the mint has. Every one of them is a PDA of our program, so the token
    // program's own check is what refuses.
    const T22 = TOKEN_2022_PROGRAM_ID
    await onChain(
      'token',
      'mint_to, as the mint authority',
      [createMintToInstruction(mint, aliceAccount, operational, 1_000_000n, [], T22)],
      key,
      byToken,
    )
    await onChain(
      'token',
      'thawing a holder never let in',
      [createThawAccountInstruction(strangerAccount, mint, operational, [], T22)],
      key,
      byToken,
    )
    await onChain(
      'token',
      'freezing a holder',
      [createFreezeAccountInstruction(aliceAccount, mint, operational, [], T22)],
      key,
      byToken,
    )
    await onChain(
      'token',
      'burning a holder’s balance',
      [createBurnCheckedInstruction(aliceAccount, mint, operational, 1_000n, DECIMALS, [], T22)],
      key,
      byToken,
    )
    await onChain(
      'token',
      'moving a holder’s balance, as the permanent delegate',
      [
        await createTransferCheckedWithTransferHookInstruction(
          connection,
          aliceAccount,
          mint,
          bobAccount,
          operational,
          1_000n,
          DECIMALS,
          [],
          'confirmed',
          T22,
        ),
      ],
      key,
      byToken,
    )
    await onChain(
      'token',
      'pausing the mint',
      [createPauseInstruction(mint, operational, [], T22)],
      key,
      byToken,
    )
    await onChain(
      'token',
      'taking the mint authority',
      [
        createSetAuthorityInstruction(
          mint,
          operational,
          AuthorityType.MintTokens,
          operational,
          [],
          T22,
        ),
      ],
      key,
      byToken,
    )
    await onChain(
      'token',
      're-pointing the transfer hook',
      [createUpdateTransferHookInstruction(mint, operational, SystemProgram.programId, [], T22)],
      key,
      byToken,
    )
    // Not `AccountOwner`: an ATA refuses that to anyone (`ImmutableOwner`), and
    // the refusal would be about the account, not about who signed.
    await onChain(
      'token',
      'becoming a holder’s close authority',
      [
        createSetAuthorityInstruction(
          aliceAccount,
          operational,
          AuthorityType.CloseAccount,
          operational,
          [],
          T22,
        ),
      ],
      key,
      byToken,
    )

    // Through the api: naming the key as the signer of each action.
    const asKey = `?signer=${operational.toBase58()}`
    const apiAttempts: [string, string, unknown][] = [
      [
        'freeze',
        `/api/tokens/${mintAddress}/freezes${asKey}`,
        { wallet: keys.alice.publicKey.toBase58(), reason: REASON },
      ],
      [
        'propose a pause',
        `/api/tokens/${mintAddress}/actions${asKey}`,
        { action: { kind: 'pause', reason: INCIDENT }, termSeconds: TERM_SECONDS },
      ],
      ['approve', `/api/actions/${target.toBase58()}/approve${asKey}`, {}],
      ['execute', `/api/actions/${target.toBase58()}/execute${asKey}`, {}],
      ['close', `/api/actions/${target.toBase58()}/close${asKey}`, {}],
      ['revoke a power', `/api/issuer/delegation/revoke${asKey}`, { powers: ['THAW_HOLDER'] }],
      [
        'propose a rotation',
        `/api/issuer/delegation/proposals${asKey}`,
        { operationalKey: successor.toBase58(), mask: DELEGATION_ALL, termSeconds: TERM_SECONDS },
      ],
    ]
    for (const [what, path, payload] of apiAttempts) {
      const response = await request('POST', path, payload)
      const answer = (await response.json()) as {
        transaction?: unknown
        error?: { message?: string }
      }
      keyAttempts.push({
        layer: 'api',
        what,
        ok:
          response.status === 400 &&
          answer.transaction === undefined &&
          (answer.error?.message ?? '').includes('cannot sign'),
        detail: `${response.status} ${answer.error?.message ?? ''}`,
      })
    }

    for (const attempt of keyAttempts) {
      console.log(
        `  ${attempt.ok ? 'ok  ' : 'FAIL'}   [${attempt.layer}] ${attempt.what.padEnd(52)} ${attempt.detail}`,
      )
    }
    const byLayer = (layer: string) => keyAttempts.filter((a) => a.layer === layer)
    check(
      'every attempt by the key refused for who signed it',
      keyAttempts.length >= 10 && keyAttempts.every((a) => a.ok),
      `${keyAttempts.filter((a) => a.ok).length} of ${keyAttempts.length} · program ${byLayer('program').length} · token ${byLayer('token').length} · api ${byLayer('api').length}`,
    )

    // The state each attempt aimed at, read back.
    const totals = await summary()
    const mintInfo = await connection.getParsedAccountInfo(mint)
    const parsed = (
      mintInfo.value?.data as {
        parsed?: {
          info?: {
            mintAuthority?: string
            supply?: string
            extensions?: { extension: string; state: { programId?: string } }[]
          }
        }
      }
    )?.parsed?.info
    const hook = parsed?.extensions?.find((e) => e.extension === 'transferHook')?.state.programId
    const aliceOwner = (
      (await connection.getParsedAccountInfo(aliceAccount)).value?.data as {
        parsed?: { info?: { owner?: string; state?: string } }
      }
    )?.parsed?.info
    const strangerState = (
      (await connection.getParsedAccountInfo(strangerAccount)).value?.data as {
        parsed?: { info?: { state?: string } }
      }
    )?.parsed?.info?.state
    const after = await delegation()
    const pending = await call(
      'GET',
      `/api/actions/${target.toBase58()}`,
      proposalDetailResponseSchema,
    )
    const vault = await balanceOf(seizureVaultAddress(mint))
    check(
      'nothing moved: supply, authorities, hook, holders, roster',
      parsed?.supply === SUPPLY.toString() &&
        parsed?.mintAuthority === tokenConfigPda(mint).toBase58() &&
        hook === program.programId.toBase58() &&
        aliceOwner?.owner === keys.alice.publicKey.toBase58() &&
        aliceOwner?.state === 'initialized' &&
        strangerState === 'frozen' &&
        !totals.paused &&
        after.operationalKey === operational.toBase58() &&
        after.mask === DELEGATION_ALL &&
        pending.proposal.state === 'open' &&
        pending.proposal.approvals.join() === founder.toBase58(),
      `supply ${parsed?.supply} · hook ${hook?.slice(0, 6)}… · alice ${aliceOwner?.state} · stranger ${strangerState} · paused ${totals.paused} · mask ${after.mask} · pause ${pending.proposal.counted}/${pending.proposal.required} · vault ${vault}`,
    )

    const failed = checks.filter((c) => !c.ok).length
    console.log(`\nT036:    ${checks.length - failed} of ${checks.length} checks passed`)
    console.log(`open proposals: ${proposals.length} — rent back after ${TERM_SECONDS / 60} min:`)
    console.log(
      `         node --env-file=.env tools/demo/src/us2.ts --close ${runPath} --rpc ${rpc} --payer ${payerPath}`,
    )
    return failed === 0 ? 0 : 1
  } finally {
    await session.close()
  }
}

/**
 * Gives back the rent of the run's lapsed proposals, then the founder's SOL.
 *
 * A proposal with one approval cannot be closed before its term ends (the
 * program's `closable`), so the measurement leaves them open, and this pass
 * comes back for them.
 */
async function closeRun(path: string, rpc: string, payer: Keypair): Promise<number> {
  const run = JSON.parse(readFileSync(path, 'utf8')) as RunFile
  const founder = Keypair.fromSecretKey(Uint8Array.from(run.founderSecret))
  const connection = new Connection(rpc, { commitment: 'confirmed', fetch: unpacedFetch() })
  const program = createForgeProgram(connection)
  const issuerId = new PublicKey(run.issuerId)

  let left = 0
  for (const address of run.proposals) {
    const proposal = new PublicKey(address)
    const account = await connection.getAccountInfo(proposal)
    if (account === null) continue
    try {
      await submitPlan(
        connection,
        await buildCloseActionProposal(program, {
          issuerId,
          proposal,
          rentRecipient: founder.publicKey,
          member: founder.publicKey,
        }),
        [founder],
      )
      console.log(`closed   ${address}`)
    } catch (error) {
      left += 1
      console.log(`left     ${address} — ${(error as Error).message.split('\n')[0]}`)
    }
  }

  const balance = await connection.getBalance(founder.publicKey)
  const fee = 5_000
  if (left === 0 && balance > fee) {
    await submit(
      connection,
      founder.publicKey,
      [
        SystemProgram.transfer({
          fromPubkey: founder.publicKey,
          toPubkey: payer.publicKey,
          lamports: balance - fee,
        }),
      ],
      [founder],
    )
    console.log(`returned ${(balance - fee) / 1e9} SOL to ${payer.publicKey.toBase58()}`)
  }
  return left === 0 ? 0 : 1
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error)
  return 2
})
