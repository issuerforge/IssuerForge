// Publishing a reserve attestation (FR-021, FR-024): the attestor's handler.
//
// **The attestor is the token's, read from the chain.** `attest_reserve`
// accepts exactly `TokenConfig.attestor`, and a quorum can replace it at any
// moment (T037), so the roster mirror is not asked who it is — only whether
// this session holds that key.
//
// **Two refusals the program does not make.** An attestation already expired
// on arrival, or dated before the latest one, is accepted on chain and becomes
// the latest — stopping issuance at once — and the record is append-only, so
// there is no taking it back. Either is a mistake far more often than an
// intent, and the route refuses it before a signature.
import {
  buildAttestReserve,
  issuerConfigPda,
  MAX_TRANSACTION_BYTES,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { hasRole, ROLE } from '@forge/shared/api'
import { addressSchema, fromU64, toU64 } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import type { ChainReader } from '../chain.ts'
import { type AttestationResponse, attestationBodySchema } from '../contracts/attestations.ts'
import type { AppEnv } from '../env.ts'
import { internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import type { ReserveReader } from '../reserve.ts'

export interface AttestationRouteDeps {
  chain: ChainReader
  reserve: ReserveReader
  now: () => Date
}

export function createAttestationRoutes(deps: AttestationRouteDeps) {
  const app = new Hono<AppEnv>()

  const body = zValidator('json', attestationBodySchema, (result) => {
    if (!result.success) throw result.error
  })

  app.post('/tokens/:mint/attestations', body, async (c) => {
    const session = c.get('session')
    const parsed = addressSchema.safeParse(c.req.param('mint'))
    if (!parsed.success) throw invalidInput('mint is not a base58 address')
    const mint = parsed.data

    const terms = await deps.reserve.terms(new PublicKey(mint))
    const own = issuerConfigPda(new PublicKey(session.issuerId)).toBase58()
    if (terms === undefined || terms.issuerConfig !== own) {
      throw notFound('this issuer has no such token')
    }
    if (!hasRole(session.roles, ROLE.ATTESTOR)) {
      throw unauthorized('only the reserve attestor publishes an attestation')
    }
    if (!session.wallets.includes(terms.attestor)) {
      throw unauthorized("no wallet of this session is this token's attestor", {
        attestor: terms.attestor,
      })
    }

    const input = c.req.valid('json')
    const now = Math.floor(deps.now().getTime() / 1000)
    if (input.attestedAt > now) {
      throw invalidInput('the attestation is dated in the future', { now })
    }
    if (now - input.attestedAt > terms.attestationMaxAge) {
      throw invalidInput('the attestation would already be expired when published', {
        attestedAt: input.attestedAt,
        now,
        maxAgeSeconds: terms.attestationMaxAge,
      })
    }
    if (terms.latest !== null && input.attestedAt < terms.latest.attestedAt) {
      throw invalidInput('the attestation is dated before the latest one', {
        attestedAt: input.attestedAt,
        latestAttestedAt: terms.latest.attestedAt,
      })
    }

    const attestor = new PublicKey(terms.attestor)
    const plan = await buildAttestReserve(deps.chain.program, {
      mint: new PublicKey(mint),
      index: terms.attestationCount,
      amount: toU64(input.amount),
      currency: terms.currency,
      attestedAt: input.attestedAt,
      attestationMaxAge: terms.attestationMaxAge,
      attestor,
      payer: attestor,
    })

    const blockhash = await deps.chain.latestBlockhash()
    const unsigned = toUnsigned(plan, blockhash)
    const bytes = transactionBytes(unsigned.transaction)
    if (bytes > MAX_TRANSACTION_BYTES) {
      throw internal(`${plan.step} does not fit in a transaction`, {
        bytes,
        limit: MAX_TRANSACTION_BYTES,
      })
    }

    c.get('log').info(
      { mint, index: terms.attestationCount.toString(), amount: input.amount },
      'attestation assembled',
    )
    return c.json({
      mint,
      index: fromU64(terms.attestationCount),
      attestor: terms.attestor,
      currency: terms.currency,
      attestationMaxAge: terms.attestationMaxAge,
      blockhash,
      transaction: {
        step: unsigned.step,
        base64: unsigned.base64,
        signers: unsigned.signers.map((key) => key.toBase58()),
        dependsOnPrevious: unsigned.dependsOnPrevious,
        bytes,
      },
    } satisfies AttestationResponse)
  })

  return app
}
