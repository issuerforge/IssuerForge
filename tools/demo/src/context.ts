// Оточення прогону: мережа, ключі, гроші на оренду.
//
// **Ключі генеруються на кожен прогін і нікуди не зберігаються.** Демо
// створює власного емітента з нуля — саме це й міряє SC-001 («на чистому
// акаунті»). Постійний ключ зробив би другий прогін дешевшим за перший, тобто
// зіпсував би вимір, заради якого все й робиться.
//
// `--payer` цього не міняє: гаманець деплою лише **доливає** свіжим ключам
// замість крана, а підписують і володіють усім усе ті самі одноразові ключі.
import { readFileSync } from 'node:fs'
import { createForgeProgram, decodeBase58, type ForgeProgram } from '@forge/chain'
import {
  Connection,
  type FetchFn,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SystemProgram,
} from '@solana/web3.js'
import { submit } from './send.ts'

export interface DemoKeys {
  /** Платник оренди й комісій. Він же засновник-адміністратор. */
  readonly founder: Keypair
  /**
   * Офіцер комплаєнсу: другий підпис кворуму.
   *
   * Не декорація складу: `quorum_n = 2` вимагає **двох** уповноважених, а
   * атестатор до них не належить — FR-024 не дає йому жодних інших повноважень.
   * Емітент із самим лише засновником програма не створює взагалі.
   */
  readonly officer: Keypair
  /** Роль атестатора: підписує атестацію резерву поруч із засновником. */
  readonly attestor: Keypair
  /** Операційний ключ платформи. У демо він живе тут, у продукті — в api. */
  readonly operational: Keypair
  /** Ідентифікатор емітента: seed його PDA, нічого не підписує. */
  readonly issuerId: Keypair
  /** Скарбниця платформи: сюди йде комісія з емісії. */
  readonly treasury: Keypair
  /** Два холдери: між ними йдуть перекази, і на них міряються відмови. */
  readonly alice: Keypair
  readonly bob: Keypair
  /** Юрисдикція поза дозволеними. */
  readonly carol: Keypair
  /** Заборонений у власному реєстрі емітента. */
  readonly dave: Keypair
  /** Той, кого емітент не впускав: жоден його переказ не має пройти. */
  readonly stranger: Keypair
}

export interface DemoContext {
  readonly connection: Connection
  readonly program: ForgeProgram
  readonly keys: DemoKeys
  readonly cluster: string
}

export function newKeys(): DemoKeys {
  return {
    founder: Keypair.generate(),
    officer: Keypair.generate(),
    attestor: Keypair.generate(),
    operational: Keypair.generate(),
    issuerId: Keypair.generate(),
    treasury: Keypair.generate(),
    alice: Keypair.generate(),
    bob: Keypair.generate(),
    carol: Keypair.generate(),
    dave: Keypair.generate(),
    stranger: Keypair.generate(),
  }
}

/**
 * Ліміт звертань до вузла: сплеск і темп поповнення.
 *
 * Публічний devnet ріже двома лічильниками — ~100 запитів за 10 секунд разом і
 * ~40 за 10 секунд на **один метод**, — а повний прогін це понад сотня
 * транзакцій і стільки ж читань. Без ліміту вимір показував би не роботу
 * правила, а `429`: він приходить замість відмови програми й лягає у звіт як
 * «спроба не зібралась».
 *
 * **Чому відро, а не рівний проміжок.** Рівний проміжок обкладає податком і
 * випуск теж, а випуск — це SC-001, тобто число, заради якого демо існує.
 * Перший прогін на devnet із проміжком 120 мс дав 10,0 с замість 1,2 с
 * локальних, і майже вся різниця — відкоти після `429`, а не ланцюг. Відро
 * пропускає перші тридцять запитів без затримки (випуск вкладається цілком) і
 * притримує тільки довгі цикли атак і звірки, де час нічого не міряє.
 *
 * Три запити за секунду — це 30 за десять, тобто нижче за менший із двох
 * лічильників навіть у найгіршому випадку, коли всі запити одного методу.
 */
const NODE_LIMIT = { burst: 30, perSecond: 3 } as const

const isLocal = (rpcUrl: string): boolean =>
  rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')

/**
 * `fetch` із відром токенів. `limit === undefined` — без обмежень.
 *
 * Черга потрібна, щоб два одночасні запити не забрали один токен двічі.
 * Повтор на `429` робить сам web3.js (`Retry-After`), і ці повтори теж беруть
 * токени — інакше відкат розганяв би саме те, від чого тікає.
 */
function pacedFetch(limit: { burst: number; perSecond: number } | undefined): FetchFn {
  let queue: Promise<void> = Promise.resolve()
  let tokens = limit?.burst ?? 0
  let filled = Date.now()

  const take = async (rate: { burst: number; perSecond: number }): Promise<void> => {
    const now = Date.now()
    tokens = Math.min(rate.burst, tokens + ((now - filled) / 1000) * rate.perSecond)
    filled = now
    if (tokens < 1) {
      await new Promise((resolve) => setTimeout(resolve, ((1 - tokens) / rate.perSecond) * 1000))
      filled = Date.now()
    }
    tokens = Math.max(0, tokens - 1)
  }

  const paced = async (input: unknown, init: unknown): Promise<unknown> => {
    if (limit !== undefined) {
      const turn = queue.then(() => take(limit))
      queue = turn
      await turn
    }
    return await fetch(input as string, init as RequestInit)
  }

  // `FetchFn` описаний типами node-fetch, а в рантаймі це глобальний `fetch`
  // Node. Каст стоїть рівно на цій межі й більше ніде.
  return paced as unknown as FetchFn
}

export function createContext(rpcUrl: string, overrides: Partial<DemoKeys> = {}): DemoContext {
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: pacedFetch(isLocal(rpcUrl) ? undefined : NODE_LIMIT),
  })
  return {
    connection,
    program: createForgeProgram(connection),
    // Перекриття існує рівно для одного ключа й однієї причини: у шляху `--api`
    // операційним ключем володіє процес api, а не демо. Згенерований тут ключ
    // не збігся б із `operational_key`, який перевіряє програма, і кожне
    // делеговане розморожування відмовляло б.
    keys: { ...newKeys(), ...overrides },
    cluster: rpcUrl,
  }
}

/** Секретний ключ ed25519 у base58 (формат `OPERATIONAL_SECRET_KEY`) → `Keypair`. */
export function keypairFromBase58(secret: string): Keypair {
  return Keypair.fromSecretKey(decodeBase58(secret))
}

/**
 * Ключ із файла `solana-keygen`: масив із 64 байтів у JSON.
 *
 * Формат перевіряється тут, а не першою транзакцією: «невірний підпис» через
 * п'ять хвилин прогону не каже, що не так із файлом.
 */
export function loadKeypair(path: string): Keypair {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(`${path}: expected a solana keypair file — a JSON array of 64 bytes`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]))
}

/**
 * Наливає SOL: переказом із гаманця, якщо він названий, інакше з крана.
 *
 * На локальному валідаторі airdrop безкоштовний і миттєвий. На devnet він
 * обмежений, і саме тому існує `--payer`: гаманець деплою вже має гроші, і
 * прогін бере їх звідти, а не стає в чергу до крана.
 *
 * Невдалий airdrop **не** зупиняє прогін: він лише не додає грошей, а бракує
 * їх чи ні, скаже перша ж транзакція. Невдалий переказ із гаманця — навпаки,
 * зупиняє: названий гаманець, з якого не вийшло взяти, — це помилка запуску,
 * а не властивість мережі.
 */
export async function fund(
  connection: Connection,
  address: PublicKey,
  sol: number,
  payer?: Keypair,
): Promise<boolean> {
  if (payer !== undefined) {
    await submit(
      connection,
      payer.publicKey,
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: address,
          lamports: Math.round(sol * LAMPORTS_PER_SOL),
        }),
      ],
      [payer],
    )
    return true
  }

  try {
    const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    return true
  } catch {
    return false
  }
}

export const solOf = (lamports: number): number => lamports / LAMPORTS_PER_SOL

/**
 * Час так, як його бачить **програма**, а не хост.
 *
 * `Clock::unix_timestamp` не дорівнює годиннику машини: він виводиться зі
 * слотів і відстає, коли валідатор працює довше за один прогін. Різниця в
 * секунди достатня, щоб `create_token` відхилив атестацію резерву як
 * «датовану майбутнім» — і саме це сталося на першому ж прогоні (борг T021 №6,
 * тепер підтверджений).
 *
 * `getBlockTime` повертає `null` на слоті, який ще не має часу; тоді береться
 * годинник хоста — це гірше, але краще за зупинку виміру.
 */
export async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot('confirmed')
  const time = await connection.getBlockTime(slot)
  return time ?? Math.floor(Date.now() / 1000)
}
