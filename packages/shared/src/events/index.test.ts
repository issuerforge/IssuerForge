import { describe, expect, it } from 'vitest'
import {
  attestationEventSchema,
  complianceEventSchema,
  eventKey,
  indexedEventSchema,
  refusalEventSchema,
  transferEventSchema,
} from './index.ts'

const MINT = 'So11111111111111111111111111111111111111112'
const A = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const B = 'BXP2gNKuqpqPHnAxBRTPtLmqqA6DzRXQBzZmKSDPuwtT'
const SIGNATURE =
  '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7'

const envelope = { signature: SIGNATURE, slot: 412_003_881, blockTime: 1_772_600_000, mint: MINT }

const transfer = {
  kind: 'transfer',
  ...envelope,
  eventIndex: 0,
  source: A,
  destination: B,
  sender: A,
  recipient: B,
  amount: '12000000',
} as const

const refusal = {
  kind: 'refusal',
  ...envelope,
  eventIndex: 1,
  source: A,
  destination: B,
  sender: A,
  recipient: B,
  amount: '64000000',
  code: 'TRANSFER_LIMIT_EXCEEDED',
  programError: 6009,
  ruleSlot: 4,
} as const

const compliance = {
  kind: 'compliance',
  ...envelope,
  eventIndex: 0,
  action: 'seize',
  target: B,
  amount: '18000000',
  reasonCode: 'SANCTIONS-MATCH',
  caseRef: 'REG-2026-0412',
  signers: [A, B],
} as const

const attestation = {
  kind: 'attestation',
  ...envelope,
  eventIndex: 0,
  index: 7,
  amount: '2540000000',
  currency: 'NGN',
  attestor: A,
  attestedAt: 1_772_588_000,
  expiresAt: 1_772_674_400,
} as const

describe('indexedEventSchema', () => {
  it('parses each of the four kinds', () => {
    for (const event of [transfer, refusal, compliance, attestation]) {
      expect(indexedEventSchema.parse(event)).toEqual(event)
    }
  })

  it('rejects a kind that is not indexed yet', () => {
    // Redemptions arrive at M4 (T048), proposals at M2 (T031/T032). Until
    // then they must not silently pass as an event of unknown shape.
    expect(indexedEventSchema.safeParse({ ...transfer, kind: 'redemption' }).success).toBe(false)
  })

  it('requires an on-chain identity on every event', () => {
    const { signature: _signature, ...withoutSignature } = transfer
    expect(indexedEventSchema.safeParse(withoutSignature).success).toBe(false)
    expect(indexedEventSchema.safeParse({ ...transfer, slot: -1 }).success).toBe(false)
  })
})

describe('transfer and refusal events', () => {
  it('takes an amount only as a decimal string', () => {
    expect(transferEventSchema.safeParse({ ...transfer, amount: 12_000_000 }).success).toBe(false)
  })

  it('allows a null block time but not a null slot', () => {
    expect(transferEventSchema.parse({ ...transfer, blockTime: null }).blockTime).toBeNull()
    expect(transferEventSchema.safeParse({ ...transfer, slot: null }).success).toBe(false)
  })

  it('keeps the raw program error when the code is not recognised', () => {
    const unknown = refusalEventSchema.parse({ ...refusal, code: null, programError: 6999 })
    expect(unknown.code).toBeNull()
    expect(unknown.programError).toBe(6999)
  })

  it('has no rule slot for a refusal that no rule produced', () => {
    const paused = refusalEventSchema.parse({
      ...refusal,
      code: 'TRANSFERS_PAUSED',
      programError: null,
      ruleSlot: null,
    })
    expect(paused.ruleSlot).toBeNull()
  })

  it('holds the rule slot inside the fixed 16-slot layout', () => {
    expect(refusalEventSchema.safeParse({ ...refusal, ruleSlot: 16 }).success).toBe(false)
    expect(refusalEventSchema.safeParse({ ...refusal, ruleSlot: -1 }).success).toBe(false)
  })
})

describe('compliance event', () => {
  it('refuses an action with no reason code or case reference', () => {
    // FR-017: without a reason the action is not executed, so it cannot be recorded either.
    expect(complianceEventSchema.safeParse({ ...compliance, reasonCode: '' }).success).toBe(false)
    expect(complianceEventSchema.safeParse({ ...compliance, caseRef: '' }).success).toBe(false)
  })

  it('refuses an action nobody signed', () => {
    // FR-019c: the journal shows by name who authorised the action.
    expect(complianceEventSchema.safeParse({ ...compliance, signers: [] }).success).toBe(false)
  })

  it('accepts one signer: an officer freezes an account alone', () => {
    const freeze = complianceEventSchema.parse({
      ...compliance,
      action: 'freeze',
      amount: null,
      signers: [A],
    })
    expect(freeze.signers).toEqual([A])
  })

  it('takes a null target where the action has none', () => {
    const pause = complianceEventSchema.parse({
      ...compliance,
      action: 'pause',
      target: null,
      amount: null,
    })
    expect(pause.target).toBeNull()
  })

  it('rejects an action outside the enumerated set', () => {
    expect(complianceEventSchema.safeParse({ ...compliance, action: 'mint' }).success).toBe(false)
    expect(complianceEventSchema.safeParse({ ...compliance, action: 'thaw' }).success).toBe(false)
  })
})

describe('attestation event', () => {
  it('parses a published attestation', () => {
    expect(attestationEventSchema.parse(attestation).index).toBe(7)
  })

  it('takes the reserve amount as a string, like every other amount', () => {
    expect(
      attestationEventSchema.safeParse({ ...attestation, amount: 2_540_000_000 }).success,
    ).toBe(false)
  })

  it('rejects a currency that is not a currency code', () => {
    expect(attestationEventSchema.safeParse({ ...attestation, currency: '' }).success).toBe(false)
  })
})

describe('eventKey', () => {
  it('separates two events of the same transaction', () => {
    // Splitting a transfer is a scenario from SC-002: one transaction
    // legitimately carries several transfers, so the signature alone is not
    // a key.
    expect(eventKey(transferEventSchema.parse(transfer))).not.toBe(
      eventKey(refusalEventSchema.parse(refusal)),
    )
  })

  it('is derived from the network, so a re-read deduplicates', () => {
    expect(eventKey(transferEventSchema.parse(transfer))).toBe(`${SIGNATURE}:0`)
  })
})
