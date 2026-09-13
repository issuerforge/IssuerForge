import { describe, expect, it } from 'vitest'
import { programErrorByCode, programErrorFrom } from './program-error.ts'

/** `PowerNotDelegated` — перша відмова, яку побачить делегована операція. */
const POWER_NOT_DELEGATED = 6033

const anchorLogs = (code: number) => [
  'Program ForgePo1icy1111111111111111111111111111111 invoke [1]',
  'Program log: Instruction: ThawHolder',
  `Program log: AnchorError occurred. Error Code: PowerNotDelegated. Error Number: ${code}. Error Message: the operational key was not given this power.`,
  'Program ForgePo1icy1111111111111111111111111111111 failed: custom program error: 0x1791',
]

describe('відмова програми', () => {
  it('читає номер із логів симуляції', () => {
    const error = Object.assign(new Error('Simulation failed'), {
      logs: anchorLogs(POWER_NOT_DELEGATED),
    })

    expect(programErrorFrom(error)).toEqual({
      code: POWER_NOT_DELEGATED,
      name: 'powerNotDelegated',
      message: expect.stringContaining('power'),
    })
  })

  // Обгортки по дорозі лишають від логів тільки текст повідомлення — і саме в
  // такому вигляді відмова доїжджає, коли preflight вимкнений.
  it('читає номер із шістнадцяткового хвоста повідомлення', () => {
    const message = `Transaction failed: custom program error: 0x${POWER_NOT_DELEGATED.toString(16)}`

    expect(programErrorFrom(new Error(message))?.name).toBe('powerNotDelegated')
  })

  // `confirmTransaction` віддає вже розібрану помилку **без** логів.
  it('читає номер із розібраної помилки транзакції', () => {
    expect(programErrorFrom({ InstructionError: [0, { Custom: POWER_NOT_DELEGATED }] })?.code).toBe(
      POWER_NOT_DELEGATED,
    )
  })

  // Лог має пріоритет над текстом: у ньому номер стоїть десятковим і без
  // ризику сплутати його з чужим шістнадцятковим хвостом.
  it('віддає перевагу логам перед текстом повідомлення', () => {
    const error = Object.assign(new Error('custom program error: 0x0'), {
      logs: anchorLogs(6037),
    })

    expect(programErrorFrom(error)?.name).toBe('holderStatusRequired')
  })

  // Вбудовані коди Anchor приходять тим самим шляхом, і саме вони означають
  // «токен ще не створений» — без них делегована операція мовчала б.
  it('розбирає вбудовані коди Anchor', () => {
    expect(programErrorByCode(3012)).toEqual({
      code: 3012,
      name: 'AccountNotInitialized',
      message: 'The program expected this account to be already initialized',
    })
  })

  it.each([
    ['обрив мережі', new Error('fetch failed')],
    ['порожній об’єкт', {}],
    ['рядок', 'boom'],
    ['null', null],
    ['невідомий номер', { InstructionError: [0, { Custom: 999_999 }] }],
  ])('%s не є відмовою програми', (_name, error) => {
    // `undefined` тут значуще: мережеву невдачу не можна показувати як відмову
    // правила, бо ланцюг про неї нічого не казав.
    expect(programErrorFrom(error)).toBeUndefined()
  })
})
