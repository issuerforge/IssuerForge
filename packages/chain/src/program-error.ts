// Відмова програми, витягнена з того, що кидає мережа.
//
// Потрібне рівно там, де транзакцію відправляє не браузер, а ми самі
// (`OperationalDelegation`, FR-035b): консоль показує відмову з підпису людини
// сама, а делеговану операцію бачить тільки API — і без цього розбору вона
// перетворилася б на «щось не вдалося» з кодом 500.
//
// **Номер коду шукається у вендорованому IDL, а не в списку поруч.** Другий
// перелік розійшовся б із програмою на першій же новій відмові; тут же джерело
// те саме, що й у самої програми, і назва з поясненням приходять з нього.
import { LangErrorCode, LangErrorMessage } from '@coral-xyz/anchor'
import { IDL } from './idl/issuer-forge.ts'

export interface ProgramError {
  /** Номер, як його бачить мережа: 6000+ — наші, 100…3013 — вбудовані Anchor. */
  readonly code: number
  readonly name: string
  readonly message: string
}

/**
 * Вбудовані коди Anchor (`AccountNotInitialized`, `ConstraintSeeds`, …) теж
 * мусять читатись словами: у делегованій операції саме вони означають «токен ще
 * не підтверджений мережею» або «акаунт не той», і людині це треба сказати.
 *
 * Зворотної мапи в `LangErrorCode` немає — це об'єкт «назва → номер», а не
 * enum із подвійним записом, тож вона будується тут один раз.
 */
const LANG_ERROR_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(LangErrorCode).map(([name, code]) => [code, name] as const),
)

export function programErrorByCode(code: number): ProgramError | undefined {
  const declared = IDL.errors.find((error) => error.code === code)
  if (declared !== undefined) {
    return { code, name: declared.name, message: declared.msg }
  }

  const message = LangErrorMessage.get(code)
  if (message !== undefined) {
    return { code, name: LANG_ERROR_NAMES.get(code) ?? 'anchorError', message }
  }

  return undefined
}

/** Рядки лога симуляції, якщо вони є. Форма — `SendTransactionError`. */
function logsOf(error: object): readonly string[] {
  const logs = (error as { logs?: unknown }).logs
  return Array.isArray(logs) ? logs.filter((line): line is string => typeof line === 'string') : []
}

/**
 * Номер відмови з трьох форм, у яких він приходить.
 *
 * Форми різні не з примхи бібліотеки: `sendTransaction` падає з логами
 * симуляції, `confirmTransaction` віддає розібрану `TransactionError` без
 * логів, а обгортки по дорозі лишають тільки текст повідомлення. Розбирати одну
 * з них означало б, що відмова читається словами через раз.
 */
function codeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  // `Error Number: 6033.` — рядок, який пише сам Anchor у лог програми.
  for (const line of logsOf(error)) {
    const match = /Error Number: (?<code>\d+)/.exec(line)
    const code = match?.groups?.code
    if (code !== undefined) return Number(code)
  }

  // `InstructionError: [0, { Custom: 6033 }]` — розібрана помилка транзакції.
  const instruction = (error as { InstructionError?: unknown }).InstructionError
  if (Array.isArray(instruction)) {
    const detail = instruction[1]
    if (typeof detail === 'object' && detail !== null) {
      const custom = (detail as { Custom?: unknown }).Custom
      if (typeof custom === 'number') return custom
    }
  }

  // `custom program error: 0x1798` — те, що лишається в тексті повідомлення.
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string') {
    const match = /custom program error: 0x(?<hex>[0-9a-f]+)/i.exec(message)
    const hex = match?.groups?.hex
    if (hex !== undefined) return Number.parseInt(hex, 16)
  }

  return undefined
}

/**
 * Що саме відмовила програма — або `undefined`, якщо це взагалі не її відмова.
 *
 * `undefined` тут значуще: обрив мережі, вичерпаний строк і зламаний RPC не є
 * відповіддю про стан ланцюга, і показувати їх як відмову правила означало б
 * збрехати про причину.
 */
export function programErrorFrom(error: unknown): ProgramError | undefined {
  const code = codeOf(error)
  return code === undefined ? undefined : programErrorByCode(code)
}
