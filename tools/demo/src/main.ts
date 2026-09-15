// Демо-сценарій US1 і вимір критеріїв M1 (T024).
//
// **Не тест, а вимір.** Тести доводять, що код робить те, що написано; цей
// скрипт доводить числа, які стоять у таблиці віхи: скільки часу займає випуск,
// скільки коштує переказ і скільки спроб порушити правило пройшло (жодна).
//
// Запуск:
//   node tools/demo/src/main.ts --rpc http://127.0.0.1:8899
//   node tools/demo/src/main.ts --rpc https://api.devnet.solana.com \
//     --payer ~/.config/solana/id.json
import { buildTransfer } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { type Keypair, PublicKey } from '@solana/web3.js'
import { runAttacks } from './attacks.ts'
import { createContext, fund, loadKeypair, solOf } from './context.ts'
import { measureCost } from './cost.ts'
import { createAta, onboard, setStatus } from './holders.ts'
import { issueToken } from './issuance.ts'
import { createIssuer } from './issuer.ts'
import { checkParity, type Party, type Scenario } from './parity.ts'
import { attemptOverReserve } from './reserve.ts'
import { submitPlan } from './send.ts'

/** Програма-посередник для вектора CPI. Адреса та, що в `Anchor.toml`. */
const ATTACKER_PROGRAM = new PublicKey('9ZCmUGqkrtBrm83uiiMwBgRrV2cBPE9HGMgA25iRJGkQ')

interface Options {
  readonly rpc: string
  /** База api. Порожня — демо йде прямо в ланцюг, повз резервацію номера. */
  readonly api: string | undefined
  /**
   * Файл ключа, з якого беруться гроші на прогін. Порожній — кран.
   *
   * На devnet кран дає 2 SOL за раз і не завжди, тож прогін залежав би від
   * настрою крана, а не від коду. Гаманець деплою вже має гроші й на devnet
   * потрібен однаково — це той самий ключ, яким програма туди покладена.
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
 * Скільки наливається засновнику й операційному ключу.
 *
 * З крана береться щедро: локально це нічого не коштує. З гаманця — рівно
 * стільки, скільки треба з запасом: прогін не прибирає за собою (борг №5), тож
 * усе, що налито понад витрачене, лишається на одноразовому ключі назавжди.
 *
 * Числа зняті з виміру, а не назначені: повний прогін спалює **0,0475 SOL** на
 * засновнику (оренда емітента, mint, політики, атестації та семи ATA плюс
 * комісії ста тридцяти транзакцій) і соті цього на операційному ключі. Запас —
 * чотирикратний.
 */
const FUNDING = {
  faucet: { founder: 5, operational: 1 },
  wallet: { founder: 0.2, operational: 0.05 },
} as const

/**
 * Політика демо: власний реєстр емітента, рівень 2, дві країни, обидва ліміти.
 *
 * Джерело `provider` навмисно не приймається. Атестації провайдера живуть у
 * спільному сервісі атестацій, якого на локальному валідаторі немає; політика,
 * що їх приймає, дала б `*_STATUS_MISSING` на кожному переказі — тобто
 * вимірювала б відсутність сервісу, а не роботу правила.
 */
const DEMO_POLICY: PolicyRules = {
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 24 * 3600 },
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const context = createContext(options.rpc)
  const { keys, connection } = context

  console.log(`cluster: ${options.rpc}`)
  console.log(`founder: ${keys.founder.publicKey.toBase58()}`)

  const payer: Keypair | undefined =
    options.payer === undefined ? undefined : loadKeypair(options.payer)
  const amounts = payer === undefined ? FUNDING.faucet : FUNDING.wallet

  if (payer !== undefined) {
    const available = solOf(await connection.getBalance(payer.publicKey))
    console.log(`payer:   ${payer.publicKey.toBase58()} · ${available} SOL`)
    // Перевірка тут, а не «перша транзакція скаже»: порожній гаманець посеред
    // прогону лишає позаду половину емітента й спалені комісії.
    const needed = amounts.founder + amounts.operational
    if (available < needed) {
      throw new Error(`payer holds ${available} SOL, and the run needs at least ${needed}`)
    }
  }

  // Засновник платить оренду за все: конфіг емітента, mint, політику,
  // атестацію, два акаунти на кожного холдера.
  const funded = await fund(connection, keys.founder.publicKey, amounts.founder, payer)
  // Операційний ключ платить за власні транзакції сам: `set_holder_status`
  // платника окремо не має, тож комісію несе той, хто санкціонує (T020). Це не
  // деталь демо, а економічний наслідок делегації — платформа платить за
  // рутину, яку їй доручили.
  await fund(connection, keys.operational.publicKey, amounts.operational, payer)
  const balance = await connection.getBalance(keys.founder.publicKey)
  console.log(
    `balance: ${solOf(balance)} SOL${funded ? '' : ' (airdrop refused; using what is there)'}`,
  )

  const issuer = await createIssuer(context)
  console.log(`issuer:  ${issuer.issuerId.toBase58()} · ${issuer.sent.computeUnits ?? '?'} CU`)

  const issuance = await issueToken(context, {
    issuerId: issuer.issuerId,
    tokenIndex: 0,
    decimals: 2,
    policy: DEMO_POLICY,
    initialSupply: 2_500_000_000n,
    reserveAmount: 2_540_000_000n,
    reserveCurrency: 'NGN',
    feeBps: 12,
    attestationMaxAge: BigInt(24 * 3600),
    name: 'Vantara Naira',
    symbol: 'vNGN',
    uri: 'https://vantara.example/vngn.json',
  })

  console.log(`mint:    ${issuance.addresses.mint.toBase58()}`)
  for (const [index, step] of issuance.steps.entries()) {
    console.log(
      `  ${index + 1}. ${step.bytes} bytes · ${step.computeUnits ?? '?'} CU · ${step.feeLamports ?? '?'} lamports`,
    )
  }
  console.log(`issued in ${(issuance.elapsedMs / 1000).toFixed(1)} s`)

  const mint = issuance.addresses.mint

  // Двоє холдерів, обидва в дозволеній юрисдикції й з потрібним рівнем: усе,
  // що далі відмовляє, відмовляє через **правило**, а не через незаповнений
  // статус.
  const alice = await onboard(context, mint, issuer.issuerId, keys.alice, {
    tier: 2,
    jurisdiction: 'NG',
    denied: false,
    expiresAt: 0n,
  })
  const bob = await onboard(context, mint, issuer.issuerId, keys.bob, {
    tier: 2,
    jurisdiction: 'GH',
    denied: false,
    expiresAt: 0n,
  })
  console.log(`holders: alice ${alice.thawed.computeUnits} CU · bob ${bob.thawed.computeUnits} CU`)

  // Засновник тримає весь випуск: перший переказ іде від нього.
  const founderAta = await onboard(context, mint, issuer.issuerId, keys.founder, {
    tier: 2,
    jurisdiction: 'NG',
    denied: false,
    expiresAt: 0n,
  }).catch(() => undefined)
  void founderAta

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

  // ── SC-008: симуляція проти мережі ────────────────────────────────────────
  // Стоїть **перед** спробами порушення: ті вичерпують ліміт за період, і
  // після них кожен сценарій відмовляв би однією й тією ж причиною.
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

  // ── SC-003: скільки коштує правило ────────────────────────────────────────
  const cost = await measureCost(context, moved, 2, keys.alice.publicKey)
  console.log(
    `cost:    with rule ${cost.withRule.computeUnits} CU / ${cost.withRule.feeLamports} lamports` +
      ` · without ${cost.withoutRule.computeUnits} CU / ${cost.withoutRule.feeLamports} lamports`,
  )
  console.log(
    `         ratio ${cost.computeRatio?.toFixed(2) ?? '?'}× in compute, ` +
      `${cost.feeRatio?.toFixed(2) ?? '?'}× in lamports`,
  )

  // ── SC-002: спроби порушити правило ───────────────────────────────────────
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

  // ── SC-005 (частково): випуск понад атестований резерв ────────────────────
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
