// Вибір підписанта серед складу емітента.
//
// Правило одне на всі ручки: **адреси приходять зі складу, а не з тіла
// запиту**. Тіло може лише звузити вибір до одного з уже доведених — те саме,
// що вміє `X-Issuer-Id` для орендаря (`session.ts`). Інакше «хто підписує»
// стало б полем, яке заповнює клієнт.
//
// Функція жила в `routes/tokens.ts` (T021) і переїхала сюди без змін, коли
// другий маршрут (`routes/holders.ts`, T022) став обирати підписанта за тим
// самим правилом: копія розійшлася б із оригіналом рівно там, де правило й
// важливе.
import type { RosterEntry } from './directory.ts'
import { invalidInput } from './errors.ts'

/**
 * Один із кандидатів на підпис.
 *
 * Порожній перелік — не помилка вибору, тож рішення про код відмови ухвалює
 * викликач: «у складі немає атестатора» і «в цій сесії немає адміністратора» —
 * різні речі й різні коди.
 */
export function chooseSigner(
  candidates: readonly RosterEntry[],
  requested: string | undefined,
  label: string,
): string | undefined {
  const wallets = candidates.map((entry) => entry.wallet)
  if (wallets.length === 0) return undefined

  if (requested === undefined) {
    const only = wallets[0]
    if (wallets.length === 1 && only !== undefined) return only
    throw invalidInput(`this issuer has several wallets that can sign as ${label}: name one`, {
      [label]: wallets,
    })
  }

  if (!wallets.includes(requested)) {
    throw invalidInput(`the wallet named as ${label} cannot sign in that role`, {
      [label]: wallets,
    })
  }
  return requested
}
