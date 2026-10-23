import {
  buildAttestReserve,
  createForgeProgram,
  fromBase64,
  issuerConfigPda,
  reserveAttestationPda,
  tokenConfigPda,
} from '@forge/chain'
import { ROLE } from '@forge/shared/api'
import { createLogger } from '@forge/shared/log'
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ActionReader } from '../actions.ts'
import type { ChainReader } from '../chain.ts'
import type { ComplianceReader } from '../compliance.ts'
import { attestationResponseSchema } from '../contracts/attestations.ts'
import type { Directory } from '../directory.ts'
import type { HolderStore } from '../holders.ts'
import type { IssuanceStore } from '../issuance.ts'
import type { JournalStore } from '../journal.ts'
import type { OperationalSigner } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import type { ReserveTerms } from '../reserve.ts'
import { createServer } from '../server.ts'

const ISSUER = '11111111111111111111111111111112'
const ATTESTOR = 'SysvarC1ock11111111111111111111111111111111'
const ADMIN = 'SysvarS1otHashes111111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const OWN_CONFIG = issuerConfigPda(new PublicKey(ISSUER)).toBase58()
const NOW = 1_800_000_000
const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))
const WEEK = 604_800

const unused = <T extends object>(name: string) =>
  new Proxy({} as T, {
    get: (_, key) => () => {
      throw new Error(`${name} is not read on this path (${String(key)})`)
    },
  })

const terms = (over: Partial<ReserveTerms> = {}): ReserveTerms => ({
  issuerConfig: OWN_CONFIG,
  attestor: ATTESTOR,
  attestationMaxAge: WEEK,
  attestationCount: 3n,
  currency: 'NGN',
  feeBps: 12,
  latest: {
    index: 2n,
    amount: 1_000n,
    currency: 'NGN',
    attestor: ATTESTOR,
    attestedAt: NOW - 86_400,
  },
  ...over,
})

type Fakes = { wallets?: string[]; roles?: number; terms?: ReserveTerms | undefined }

function app(fakes: Fakes = {}) {
  const wallets = fakes.wallets ?? [ATTESTOR]
  const chain: ChainReader = {
    program,
    tokenCount: async () => 1,
    issuerConfig: async () => undefined,
    holderStatusWritten: async () => false,
    latestBlockhash: async () => BLOCKHASH,
  }
  const privy: PrivyClient = { authenticate: async () => ({ userId: 'did:privy:test', wallets }) }
  const directory: Directory = {
    membershipsFor: async () => [
      {
        issuerId: ISSUER,
        roles: fakes.roles ?? ROLE.ATTESTOR,
        wallets,
        syncedAt: '2026-10-23T10:00:00.000Z',
      },
    ],
    rosterFor: async () => [],
  }

  return createServer({
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    now: () => new Date(NOW * 1000),
    privy,
    directory,
    chain,
    reserve: { terms: async () => ('terms' in fakes ? fakes.terms : terms()) },
    actions: unused<ActionReader>('the action reader'),
    compliance: unused<ComplianceReader>('the compliance reader'),
    delegations: { history: async () => [] },
    issuance: unused<IssuanceStore>('issuance'),
    holders: unused<HolderStore>('the holder store'),
    journal: unused<JournalStore>('the journal'),
    operational: unused<OperationalSigner>('the operational key'),
  })
}

const attest = (fakes: Fakes, json: unknown) =>
  app(fakes).request(`/api/tokens/${MINT}/attestations`, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(json),
  })

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error

const valid = { amount: '2540000000', attestedAt: NOW - 3_600 }

describe('POST /api/tokens/:mint/attestations — assembly', () => {
  it('writes the next record, signed and paid for by the token’s attestor alone', async () => {
    const response = await attest({}, valid)
    expect(response.status).toBe(200)
    const body = attestationResponseSchema.parse(await response.json())

    expect(body).toMatchObject({
      mint: MINT,
      index: '3',
      attestor: ATTESTOR,
      currency: 'NGN',
      attestationMaxAge: WEEK,
      blockhash: BLOCKHASH,
    })
    expect(body.transaction.step).toBe('attest-reserve')
    expect(body.transaction.signers).toEqual([ATTESTOR])

    const message = fromBase64(body.transaction.base64).message
    const keys = message.getAccountKeys()
    const [instruction] = message.compiledInstructions
    if (instruction === undefined) throw new Error('expected an instruction')
    expect(instruction.accountKeyIndexes.map((index) => keys.get(index)?.toBase58())).toEqual([
      tokenConfigPda(new PublicKey(MINT)).toBase58(),
      reserveAttestationPda(new PublicKey(MINT), 3n).toBase58(),
      ATTESTOR,
      ATTESTOR,
      SystemProgram.programId.toBase58(),
    ])

    // The currency, the period and the index come from the chain, not the request.
    const expected = await buildAttestReserve(program, {
      mint: new PublicKey(MINT),
      index: 3n,
      amount: 2_540_000_000n,
      currency: 'NGN',
      attestedAt: NOW - 3_600,
      attestationMaxAge: WEEK,
      attestor: new PublicKey(ATTESTOR),
      payer: new PublicKey(ATTESTOR),
    })
    expect(Buffer.from(instruction.data)).toEqual(expected.instructions[0]?.data)
  })

  it('an attestation at the same moment as the latest one is accepted — a correction', async () => {
    const response = await attest({}, { amount: '1', attestedAt: NOW - 86_400 })
    expect(response.status).toBe(200)
  })
})

describe('POST /api/tokens/:mint/attestations — who', () => {
  it('another issuer’s token does not exist', async () => {
    const response = await attest(
      { terms: terms({ issuerConfig: 'Vote111111111111111111111111111111111111111' }) },
      valid,
    )
    expect(response.status).toBe(404)
  })

  it('no token at all is the same answer', async () => {
    expect((await attest({ terms: undefined }, valid)).status).toBe(404)
  })

  it('a member without the attestor role is refused', async () => {
    const response = await attest({ wallets: [ATTESTOR], roles: ROLE.ADMIN }, valid)
    expect(response.status).toBe(401)
  })

  /** The roster says attestor; the chain says a quorum has replaced them (T037). */
  it('an attestor this token no longer has is refused, and told who is', async () => {
    const response = await attest({ wallets: [ADMIN] }, valid)
    expect(response.status).toBe(401)
    const error = (await response.json()) as { error: { details: { attestor: string } } }
    expect(error.error.details.attestor).toBe(ATTESTOR)
  })
})

describe('POST /api/tokens/:mint/attestations — when', () => {
  it('a moment in the future is refused', async () => {
    const response = await attest({}, { amount: '1', attestedAt: NOW + 1 })
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/future/)
  })

  it('an attestation already expired on arrival is refused, one second past the period', async () => {
    const old = {
      terms: terms({
        latest: { index: 2n, amount: 1n, currency: 'NGN', attestor: ATTESTOR, attestedAt: 0 },
      }),
    }
    expect((await attest(old, { amount: '1', attestedAt: NOW - WEEK })).status).toBe(200)
    const late = await attest(old, { amount: '1', attestedAt: NOW - WEEK - 1 })
    expect(late.status).toBe(400)
    expect((await errorOf(late)).message).toMatch(/expired/)
  })

  it('an attestation dated before the latest one is refused', async () => {
    const response = await attest({}, { amount: '1', attestedAt: NOW - 86_401 })
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/before the latest/)
  })
})

describe('POST /api/tokens/:mint/attestations — the body', () => {
  it('the moment has no default', async () => {
    expect((await attest({}, { amount: '1' })).status).toBe(400)
  })

  it('the currency is not the caller’s to name', async () => {
    expect((await attest({}, { ...valid, currency: 'USD' })).status).toBe(400)
  })

  it('an amount past u64 is refused', async () => {
    expect((await attest({}, { ...valid, amount: '18446744073709551616' })).status).toBe(400)
  })
})
