// The US1 demo scenario and the measurement of the M1 criteria (T024).
//
// **Not a test but a measurement.** Tests prove that the code does what is
// written; this script proves the numbers in the milestone table: how long
// an issuance takes, how much a transfer costs, and how many attempts to
// violate the rule went through (none).
//
// Running (the environment is read from the root `.env`):
//   node --env-file=.env tools/demo/src/main.ts --rpc http://127.0.0.1:8899
//   node --env-file=.env tools/demo/src/main.ts \
//     --rpc https://api.devnet.solana.com --payer ~/.config/solana/id.json
//
// `--api http://127.0.0.1:8787` routes issuance and onboarding through the
// api — the same path the wizard takes. Without it the demo assembles the
// transactions itself, and SC-001 measures only the on-chain half. The
// attacks, the comparison and the transfer cost are direct in both cases:
// they measure the rule, and http would be noise in that measurement.
import { buildTransfer } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { DELEGATION } from '@forge/shared/api'
import { type Keypair, PublicKey } from '@solana/web3.js'
import { type ApiClient, createApiClient } from './api.ts'
import { runAttacks } from './attacks.ts'
import {
  createContext,
  type DemoContext,
  fund,
  keypairFromBase58,
  loadKeypair,
  solOf,
} from './context.ts'
import { measureCost } from './cost.ts'
import { createAta, onboard, setStatus } from './holders.ts'
import { issueToken } from './issuance.ts'
import { issueViaApi } from './issuance-api.ts'
import { createIssuer } from './issuer.ts'
import { type LoginSession, startLogin } from './login.ts'
import { checkParity, type Party, type Scenario } from './parity.ts'
import { attemptOverReserve } from './reserve.ts'
import { closeDatabase, openDatabase, seedIssuer } from './seed.ts'
import { submitPlan } from './send.ts'

/** The relay program for the CPI vector. The address is the one in `Anchor.toml`. */
const ATTACKER_PROGRAM = new PublicKey('9ZCmUGqkrtBrm83uiiMwBgRrV2cBPE9HGMgA25iRJGkQ')

interface Options {
  readonly rpc: string
  /** The api base. Empty — the demo goes straight to the chain, bypassing the number reservation. */
  readonly api: string | undefined
  /**
   * The key file the run's money is taken from. Empty — the faucet.
   *
   * On devnet the faucet gives 2 SOL at a time and not always, so the run
   * would depend on the faucet's mood rather than the code. The deploy wallet
   * already has funds and is needed on devnet anyway — it is the same key the
   * program was put there with.
   */
  readonly payer: string | undefined
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  return {
    rpc: value('--rpc') ?? 'http://127.0.0.1:8899',
    api: value('--api'),
    payer: value('--payer'),
  }
}

/**
 * How much is poured into the founder and the operational key.
 *
 * From the faucet, generously: locally it costs nothing. From the wallet,
 * exactly as much as needed with headroom: the run does not clean up after
 * itself (debt #5), so everything poured in beyond what is spent stays on
 * the one-off key forever.
 *
 * The numbers are taken from measurement, not assigned: a full run burns
 * **0.0475 SOL** on the founder (rent for the issuer, the mint, the policy,
 * the attestation and seven ATAs, plus fees for a hundred and thirty
 * transactions) and hundredths of that on the operational key. The headroom
 * is fourfold.
 */
const FUNDING = {
  faucet: { founder: 5, operational: 1 },
  wallet: { founder: 0.2, operational: 0.05 },
} as const

/** The environment variable without which the `--api` path does not start. */
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '' || value.includes('REPLACE_ME')) {
    throw new Error(`${name} is required for --api (read from .env via --env-file-if-exists)`)
  }
  return value
}

/**
 * Everything needed for the demo to log into the api the same way the
 * console does.
 *
 * Three steps, and none of them is a login bypass: the membership is written
 * to the database (the job of indexer T031, which does not exist yet), the
 * fixture answers the same request Privy does, and the token is signed with
 * the key whose public half the api reads from the environment and verifies
 * itself.
 */
async function openApiSession(
  context: ReturnType<typeof createContext>,
  issuerId: PublicKey,
  baseUrl: string,
): Promise<{ api: ApiClient; login: LoginSession; close: () => Promise<void> }> {
  const { keys, connection } = context

  const db = openDatabase(required('DATABASE_URL'))
  await seedIssuer(db, {
    issuerId,
    keys,
    quorumN: 2,
    delegationMask: DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS,
    slot: await connection.getSlot('confirmed'),
  })

  // The port is taken from the same address the api reads: two numbers would
  // diverge silently, and the api would call into the void.
  const fixtureUrl = new URL(required('PRIVY_API_URL'))

  const login = await startLogin(
    {
      signingKeyPem: required('LOGIN_SIGNING_KEY').replaceAll('\\n', '\n'),
      appId: required('PRIVY_APP_ID'),
      port: Number(fixtureUrl.port || '80'),
    },
    // Exactly the addresses in the membership: the fixture has no right to
    // "prove" more than Privy would.
    [
      keys.founder.publicKey.toBase58(),
      keys.officer.publicKey.toBase58(),
      keys.attestor.publicKey.toBase58(),
    ],
  )

  const api = createApiClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    accessToken: login.accessToken,
    issuerId: issuerId.toBase58(),
  })

  return {
    api,
    login,
    // Both resources hold the event loop: without this the process does not
    // exit even when all the numbers are already printed.
    close: async () => {
      await login.close()
      await closeDatabase(db)
    },
  }
}

/**
 * The demo policy: the issuer's own registry, tier 2, two countries, both
 * limits.
 *
 * The `provider` source is deliberately not accepted. Provider attestations
 * live in the shared attestation service, which the local validator does not
 * have; a policy accepting them would give `*_STATUS_MISSING` on every
 * transfer — i.e. measure the absence of the service, not the rule at work.
 */
const DEMO_POLICY: PolicyRules = {
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 24 * 3600 },
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // On the `--api` path the operational key belongs to the api process, not
  // the demo: the issuer is created with **its** address, otherwise a
  // delegated thaw is refused at `require_routine`.
  const context = createContext(
    options.rpc,
    options.api === undefined
      ? {}
      : { operational: keypairFromBase58(required('OPERATIONAL_SECRET_KEY')) },
  )
  const { keys, connection } = context

  console.log(`cluster: ${options.rpc}`)
  console.log(`founder: ${keys.founder.publicKey.toBase58()}`)

  const payer: Keypair | undefined =
    options.payer === undefined ? undefined : loadKeypair(options.payer)
  const amounts = payer === undefined ? FUNDING.faucet : FUNDING.wallet

  if (payer !== undefined) {
    const available = solOf(await connection.getBalance(payer.publicKey))
    console.log(`payer:   ${payer.publicKey.toBase58()} · ${available} SOL`)
    // The check is here, not "the first transaction will tell": an empty
    // wallet mid-run leaves behind half an issuer and burnt fees.
    const needed = amounts.founder + amounts.operational
    if (available < needed) {
      throw new Error(`payer holds ${available} SOL, and the run needs at least ${needed}`)
    }
  }

  // The founder pays rent for everything: the issuer config, the mint, the
  // policy, the attestation, two accounts per holder.
  const funded = await fund(connection, keys.founder.publicKey, amounts.founder, payer)
  // The operational key pays for its own transactions: `set_holder_status`
  // has no separate payer, so the fee is borne by whoever authorises (T020).
  // This is not a demo detail but an economic consequence of delegation —
  // the platform pays for the routine entrusted to it.
  await fund(connection, keys.operational.publicKey, amounts.operational, payer)
  const balance = await connection.getBalance(keys.founder.publicKey)
  console.log(
    `balance: ${solOf(balance)} SOL${funded ? '' : ' (airdrop refused; using what is there)'}`,
  )

  // The founder creates the issuer themselves, the same way on both paths:
  // there is no route for this and there will be none — `initialize_issuer`
  // is the only action without a quorum (T007), and a person does it with
  // their own key, not the platform on their behalf.
  const issuer = await createIssuer(context)
  console.log(`issuer:  ${issuer.issuerId.toBase58()} · ${issuer.sent.computeUnits ?? '?'} CU`)

  // ── The api path ──────────────────────────────────────────────────────────
  // From here the branching is in exactly one place: issuance and onboarding.
  // The attacks, the comparison and the cost measurement stay direct on
  // purpose — they measure the **rule**, and running them through http would
  // mean measuring http.
  const session =
    options.api === undefined
      ? undefined
      : await openApiSession(context, issuer.issuerId, options.api)

  if (session !== undefined) {
    console.log(`api:     ${options.api} · login ${session.login.did}`)
  }

  try {
    await measure(context, session?.api, issuer)
  } finally {
    // The fixture holds the port, and without this the process would not exit
    // even after a successful run.
    await session?.close()
  }
}

/**
 * Onboarding through the api: the application, then the thaw.
 *
 * **The demo still creates the ATA.** The route does not create it, nor
 * should it: the account belongs to the holder, and whoever opens it pays
 * for it. In the product the owner's wallet does that; here the founder,
 * because the demo holders have no money of their own.
 *
 * No CU comes back: the delegated path returns a signature, not a
 * measurement. The report does not need a number here — the direct run
 * already gave it, and `--api` measures the path's time, not the
 * instruction's cost.
 */
async function onboardViaApi(
  context: DemoContext,
  api: ApiClient,
  mint: PublicKey,
  wallet: PublicKey,
  jurisdiction: string,
): Promise<number | undefined> {
  await createAta(context, mint, wallet)
  await api.queueHolder(mint.toBase58(), {
    wallet: wallet.toBase58(),
    tier: 2,
    jurisdiction,
    expiresAt: null,
  })
  const thawed = await api.thawHolder(mint.toBase58(), wallet.toBase58())
  // An unsigned path would mean the delegation is not in effect — and it is the essence of T022.
  if (thawed.mode !== 'delegated') {
    throw new Error(`expected the operational key to sign the thaw, got mode=${thawed.mode}`)
  }
  return undefined
}

/** The measurement itself. The path to the token is already chosen: `api` either exists or not. */
async function measure(
  context: DemoContext,
  api: ApiClient | undefined,
  issuer: Awaited<ReturnType<typeof createIssuer>>,
) {
  const { keys } = context

  const ISSUANCE = {
    decimals: 2,
    policy: DEMO_POLICY,
    initialSupply: 2_500_000_000n,
    reserveAmount: 2_540_000_000n,
    reserveCurrency: 'NGN',
    feeBps: 12,
    name: 'Vantara Naira',
    symbol: 'vNGN',
    uri: 'https://vantara.example/vngn.json',
  } as const

  const issuance =
    api === undefined
      ? await issueToken(context, {
          ...ISSUANCE,
          issuerId: issuer.issuerId,
          tokenIndex: 0,
          attestationMaxAge: BigInt(24 * 3600),
        })
      : await issueViaApi(context, api, { ...ISSUANCE, attestationMaxAge: 24 * 3600 })

  const mint = 'mint' in issuance ? issuance.mint : issuance.addresses.mint

  console.log(`mint:    ${mint.toBase58()}`)
  for (const [index, step] of issuance.steps.entries()) {
    console.log(
      `  ${index + 1}. ${step.bytes} bytes · ${step.computeUnits ?? '?'} CU · ${step.feeLamports ?? '?'} lamports`,
    )
  }
  console.log(
    `issued in ${(issuance.elapsedMs / 1000).toFixed(1)} s` +
      ('apiMs' in issuance ? ` (api ${(issuance.apiMs / 1000).toFixed(1)} s of it)` : ''),
  )

  // Two holders, both in an allowed jurisdiction and with the required tier:
  // everything that refuses from here on refuses because of the **rule**, not
  // because of an unfilled status.
  const onboardOne = async (holder: Keypair, jurisdiction: string) =>
    api === undefined
      ? (
          await onboard(context, mint, issuer.issuerId, holder, {
            tier: 2,
            jurisdiction,
            denied: false,
            expiresAt: 0n,
          })
        ).thawed.computeUnits
      : await onboardViaApi(context, api, mint, holder.publicKey, jurisdiction)

  const aliceCu = await onboardOne(keys.alice, 'NG')
  const bobCu = await onboardOne(keys.bob, 'GH')
  console.log(`holders: alice ${aliceCu ?? '?'} CU · bob ${bobCu ?? '?'} CU`)

  // The founder holds the whole issuance: the first transfer comes from them.
  // Their account is already thawed by the issuance itself (`founderStatus`),
  // so a repeat attempt legitimately refuses — which is exactly why it is not
  // a run error.
  await onboardOne(keys.founder, 'NG').catch(() => undefined)

  const transfer = await buildTransfer(context.connection, {
    mint,
    owner: keys.founder.publicKey,
    recipient: keys.alice.publicKey,
    amount: 10_000n,
    decimals: 2,
  })
  const moved = await submitPlan(context.connection, transfer, [keys.founder])
  console.log(
    `transfer: ${moved.computeUnits} CU · ${moved.bytes} bytes · ${moved.feeLamports} lamports`,
  )

  const restated = await setStatus(context, mint, issuer.issuerId, keys.bob.publicKey, {
    tier: 1,
    jurisdiction: 'GH',
    denied: false,
    expiresAt: 0n,
  })
  console.log(`status:  ${restated.computeUnits} CU`)

  // ── SC-008: the simulation against the network ────────────────────────────
  // Comes **before** the violation attempts: those exhaust the per-period
  // limit, and after them every scenario would refuse for one and the same
  // reason.
  const carol = await onboard(context, mint, issuer.issuerId, keys.carol, {
    tier: 2,
    jurisdiction: 'PL',
    denied: false,
    expiresAt: 0n,
  })
  const dave = await onboard(context, mint, issuer.issuerId, keys.dave, {
    tier: 2,
    jurisdiction: 'NG',
    denied: true,
    expiresAt: 0n,
  })
  void carol
  void dave
  await createAta(context, mint, keys.stranger.publicKey)

  const party = (wallet: typeof keys.alice, over: Partial<Party> = {}): Party => ({
    wallet,
    tier: 2,
    jurisdiction: 'NG',
    denied: false,
    unregistered: false,
    ...over,
  })

  const LIMIT = 50_000_000n
  const allowed = party(keys.alice)
  const lowTier = party(keys.bob, { tier: 1, jurisdiction: 'GH' })
  const foreign = party(keys.carol, { jurisdiction: 'PL' })
  const denied = party(keys.dave, { denied: true })
  const frozen = party(keys.stranger, { unregistered: true })

  const scenarios: Scenario[] = [
    { name: 'allowed holder, small amount', recipient: allowed, amount: 1_000n },
    { name: 'allowed holder, exactly the limit', recipient: allowed, amount: LIMIT },
    { name: 'allowed holder, one over the limit', recipient: allowed, amount: LIMIT + 1n },
    { name: 'tier below the minimum, small', recipient: lowTier, amount: 1_000n },
    { name: 'tier below the minimum, over the limit', recipient: lowTier, amount: LIMIT + 1n },
    { name: 'jurisdiction not allowed, small', recipient: foreign, amount: 1_000n },
    { name: 'jurisdiction not allowed, over the limit', recipient: foreign, amount: LIMIT + 1n },
    { name: 'denied in the register, small', recipient: denied, amount: 1_000n },
    { name: 'denied in the register, over the limit', recipient: denied, amount: LIMIT + 1n },
    { name: 'never let in, small', recipient: frozen, amount: 1_000n },
    { name: 'never let in, over the limit', recipient: frozen, amount: LIMIT + 1n },
    { name: 'allowed holder, second slice', recipient: allowed, amount: LIMIT },
    { name: 'allowed holder, third slice', recipient: allowed, amount: LIMIT },
    { name: 'allowed holder, fourth slice', recipient: allowed, amount: LIMIT },
    { name: 'allowed holder, past the period limit', recipient: allowed, amount: LIMIT },
    { name: 'allowed holder, well past the period limit', recipient: allowed, amount: 1_000n },
  ]

  const parity = await checkParity(context, {
    mint,
    decimals: 2,
    policy: DEMO_POLICY,
    sender: party(keys.founder),
    scenarios,
    policyVersion: 1,
  })

  console.log(`parity:  ${parity.agreed} of ${parity.total} agree`)
  for (const row of parity.rows) {
    if (row.agrees) continue
    console.log(
      `  MISMATCH ${row.name}: simulated ${verdictOf(row.simulated)}, chain ${verdictOf(row.onChain)}`,
    )
  }

  // ── SC-003: what the rule costs ───────────────────────────────────────────
  const cost = await measureCost(context, moved, 2, keys.alice.publicKey)
  console.log(
    `cost:    with rule ${cost.withRule.computeUnits} CU / ${cost.withRule.feeLamports} lamports` +
      ` · without ${cost.withoutRule.computeUnits} CU / ${cost.withoutRule.feeLamports} lamports`,
  )
  console.log(
    `         ratio ${cost.computeRatio?.toFixed(2) ?? '?'}× in compute, ` +
      `${cost.feeRatio?.toFixed(2) ?? '?'}× in lamports`,
  )

  // ── SC-002: attempts to violate the rule ──────────────────────────────────
  const attacks = await runAttacks(context, {
    mint,
    decimals: 2,
    holder: keys.founder,
    stranger: keys.stranger,
    allowed: keys.alice.publicKey,
    transferLimit: 50_000_000n,
    repeats: 8,
    attackerProgram: ATTACKER_PROGRAM,
  })

  console.log(`attacks: ${attacks.refused} refused of ${attacks.total}`)
  for (const [vector, tally] of Object.entries(attacks.byVector)) {
    console.log(`  ${vector.padEnd(12)} ${tally.refused}/${tally.total}`)
  }
  const codes = new Map<string, number>()
  for (const item of attacks.attempts) {
    const key = item.refusalCode ?? item.refusedBy ?? 'not refused'
    codes.set(key, (codes.get(key) ?? 0) + 1)
  }
  for (const [code, count] of codes) console.log(`  ${code}: ${count}`)

  // ── SC-005 (partial): issuance above the attested reserve ─────────────────
  const reserve = await attemptOverReserve(context, issuer.issuerId, DEMO_POLICY, 10, 1)
  console.log(`reserve: ${reserve.refused} refused of ${reserve.attempts}`)
  console.log(`  ${[...new Set(reserve.codes)].join(', ')}`)
}

const verdictOf = (verdict: { allowed: boolean; code?: string }): string =>
  verdict.allowed ? 'allowed' : (verdict.code ?? 'refused')

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
