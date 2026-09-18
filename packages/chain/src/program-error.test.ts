import { describe, expect, it } from 'vitest'
import { programErrorByCode, programErrorFrom } from './program-error.ts'

/** `PowerNotDelegated` — the first refusal a delegated operation will see. */
const POWER_NOT_DELEGATED = 6033

const anchorLogs = (code: number) => [
  'Program ForgePo1icy1111111111111111111111111111111 invoke [1]',
  'Program log: Instruction: ThawHolder',
  `Program log: AnchorError occurred. Error Code: PowerNotDelegated. Error Number: ${code}. Error Message: the operational key was not given this power.`,
  'Program ForgePo1icy1111111111111111111111111111111 failed: custom program error: 0x1791',
]

describe('a program refusal', () => {
  it('reads the number from simulation logs', () => {
    const error = Object.assign(new Error('Simulation failed'), {
      logs: anchorLogs(POWER_NOT_DELEGATED),
    })

    expect(programErrorFrom(error)).toEqual({
      code: POWER_NOT_DELEGATED,
      name: 'powerNotDelegated',
      message: expect.stringContaining('power'),
    })
  })

  // Wrappers along the way keep only the message text of the logs — and that
  // is exactly the shape the refusal arrives in when preflight is off.
  it('reads the number from the hex tail of the message', () => {
    const message = `Transaction failed: custom program error: 0x${POWER_NOT_DELEGATED.toString(16)}`

    expect(programErrorFrom(new Error(message))?.name).toBe('powerNotDelegated')
  })

  // `confirmTransaction` returns an already parsed error **without** logs.
  it('reads the number from a parsed transaction error', () => {
    expect(programErrorFrom({ InstructionError: [0, { Custom: POWER_NOT_DELEGATED }] })?.code).toBe(
      POWER_NOT_DELEGATED,
    )
  })

  // The log takes priority over the text: there the number is decimal, with
  // no risk of confusing it with someone else's hex tail.
  it('prefers the logs over the message text', () => {
    const error = Object.assign(new Error('custom program error: 0x0'), {
      logs: anchorLogs(6037),
    })

    expect(programErrorFrom(error)?.name).toBe('holderStatusRequired')
  })

  // Anchor's built-in codes arrive by the same path, and they are what means
  // "the token is not created yet" — without them a delegated operation would
  // stay silent.
  it("parses Anchor's built-in codes", () => {
    expect(programErrorByCode(3012)).toEqual({
      code: 3012,
      name: 'AccountNotInitialized',
      message: 'The program expected this account to be already initialized',
    })
  })

  it.each([
    ['a dropped connection', new Error('fetch failed')],
    ['an empty object', {}],
    ['a string', 'boom'],
    ['null', null],
    ['an unknown number', { InstructionError: [0, { Custom: 999_999 }] }],
  ])('%s is not a program refusal', (_name, error) => {
    // `undefined` is significant here: a network failure must not be shown as
    // a rule refusal, because the chain said nothing about it.
    expect(programErrorFrom(error)).toBeUndefined()
  })
})
