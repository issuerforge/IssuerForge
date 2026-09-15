// Оточення прогону: мережа, ключі, гроші на оренду.
//
// **Ключі генеруються на кожен прогін і нікуди не зберігаються.** Демо
// створює власного емітента з нуля — саме це й міряє SC-001 («на чистому
// акаунті»). Постійний ключ зробив би другий прогін дешевшим за перший, тобто
// зіпсував би вимір, заради якого все й робиться.
import { createForgeProgram, type ForgeProgram } from '@forge/chain'
import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js'

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

export function createContext(rpcUrl: string): DemoContext {
  const connection = new Connection(rpcUrl, 'confirmed')
  return {
    connection,
    program: createForgeProgram(connection),
    keys: newKeys(),
    cluster: rpcUrl,
  }
}

/**
 * Наливає SOL там, де це можливо, і мовчки пропускає там, де ні.
 *
 * На локальному валідаторі airdrop безкоштовний і миттєвий. На devnet він
 * обмежений, тож гаманець наповнюється заздалегідь і рукою — і саме тому
 * невдалий airdrop тут **не** зупиняє прогін: він лише не додає грошей, а
 * бракує їх чи ні, скаже перша ж транзакція.
 */
export async function fund(
  connection: Connection,
  address: PublicKey,
  sol: number,
): Promise<boolean> {
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
