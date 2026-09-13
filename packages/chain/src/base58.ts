// Base58 у тій самій реалізації, якою користується решта ланцюга.
//
// Кодек живе тут, а не в `apps/api`, з двох причин. Перша: base58 у Solana — це
// не «якийсь base58», а конкретний алфавіт, і другий його примірник у репозиторії
// колись розійшовся б із першим. Друга: `@coral-xyz/anchor` уже несе цю
// реалізацію транзитивно, тож окрема залежність купила б лише зайвий рядок у
// локфайлі.
//
// **Ключа тут немає й не з'являється.** Це кодек байтів: що саме за байти
// приїхали — секретний ключ, адреса чи підпис, — цей файл не знає й знати не
// мусить. `Keypair` із них збирає `apps/api/src/operational.ts`, тобто рівно той
// процес, який єдиний має право тримати операційний ключ.
import { utils } from '@coral-xyz/anchor'

export function decodeBase58(value: string): Uint8Array {
  return Uint8Array.from(utils.bytes.bs58.decode(value))
}

export function encodeBase58(bytes: Uint8Array): string {
  return utils.bytes.bs58.encode(Buffer.from(bytes))
}

/**
 * Скільки байтів вийде з рядка — або `undefined`, якщо рядок не base58.
 *
 * Існує заради валідації оточення: конфіг мусить сказати «не той ключ» на
 * старті процесу, а не кинути виняток із надр кодека на першому розморожуванні.
 * Довжину при цьому перевіряє викликач: 32 байти — це адреса, 64 — секретний
 * ключ ed25519, і плутати їх не можна.
 */
export function base58ByteLength(value: string): number | undefined {
  try {
    return decodeBase58(value).length
  } catch {
    return undefined
  }
}
