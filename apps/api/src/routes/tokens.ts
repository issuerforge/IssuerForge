// The issuance wizard's two handlers: policy simulation (FR-004) and assembly
// of the issuance transactions (FR-001).
//
// **The body and response schemas live in `../contracts/tokens.ts`.** They
// cannot sit in `@forge/shared` (the issuance body carries a policy, and
// `policy` itself depends on `shared` — a cycle) and must not sit here: the
// console reads the same contract, and along with it would pull `hono`,
// `drizzle` and `postgres` into the bundle. The route keeps exactly the
// handlers.
//
// **There are no issuer keys here.** `POST /api/tokens` neither signs nor
// sends: what goes out is three unsigned transactions and the list of
// addresses whose signatures they lack. The wallet in the browser signs.
//
import {
  buildTokenIssuance,
  issuanceAddresses,
  MAX_TRANSACTION_BYTES,
  mintPda,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { simulateScenarios } from '@forge/policy/scenarios'
import { hasRole, ROLE } from '@forge/shared/api'
import { toU64 } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import type { z } from 'zod'
import type { ChainReader } from '../chain.ts'
import {
  type CreateTokenResponse,
  createTokenBodySchema,
  type SimulatePolicyResponse,
  simulatePolicyBodySchema,
} from '../contracts/tokens.ts'
import type { Directory } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import type { IssuanceStore } from '../issuance.ts'
import { chooseSigner } from '../signers.ts'

// A re-export for those who already read the contract from here: tests and
// the console do not care which file declares it, but two import paths for
// one value would matter.
export {
  type CreateTokenBody,
  type CreateTokenResponse,
  createTokenBodySchema,
  createTokenResponseSchema,
  type SimulatePolicyBody,
  type SimulatePolicyResponse,
  simulatePolicyBodySchema,
  simulatePolicyResponseSchema,
} from '../contracts/tokens.ts'

export interface TokenRouteDeps {
  chain: ChainReader
  directory: Directory
  issuance: IssuanceStore
  /** The server clock. Swapped in tests — time is not a hidden input. */
  now: () => Date
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function createTokenRoutes(deps: TokenRouteDeps) {
  const app = new Hono<AppEnv>()

  /**
   * A body parsing error goes the same way as the rest: `onError` turns a
   * `ZodError` into `INVALID_INPUT` with the list of fields. Without this hook
   * the validator would answer with its own body, which the client cannot
   * read.
   */
  const body = <S extends z.ZodType>(schema: S) =>
    zValidator('json', schema, (result) => {
      if (!result.success) throw result.error
    })

  /**
   * Simulation. Goes neither to the network nor asks for a role: it is a read
   * of one's own draft, not an action with funds — any member of the
   * membership may see it.
   */
  app.post('/policy/simulate', body(simulatePolicyBodySchema), (c) => {
    const { policy, scenarios } = c.req.valid('json')
    const now = Math.floor(deps.now().getTime() / 1000)

    // `satisfies` is not cosmetics here: the response and the schema the
    // console reads live in different files, and without this line a field
    // renamed here would show up as a parsing error in the browser, not as a
    // build error.
    return c.json({
      now,
      scenarios: simulateScenarios(policy, { now, names: scenarios }).map((scenario) => ({
        name: scenario.name,
        applicable: scenario.applicable,
        amount: scenario.amount,
        verdict: scenario.verdict,
      })),
    } satisfies SimulatePolicyResponse)
  })

  /** Issuance assembly: three unsigned transactions and the addresses known in advance. */
  app.post('/tokens', body(createTokenBodySchema), async (c) => {
    const input = c.req.valid('json')
    const session = c.get('session')
    const at = deps.now()
    const now = Math.floor(at.getTime() / 1000)

    const roster = await deps.directory.rosterFor(session.issuerId)

    // The founder is an address of **this session** with the admin role:
    // `create_token` requires an admin of the membership, and someone else's
    // address cannot be substituted here.
    const founder = chooseSigner(
      roster.filter(
        (entry) => hasRole(entry.roles, ROLE.ADMIN) && session.wallets.includes(entry.wallet),
      ),
      input.founder,
      'founder',
    )
    if (founder === undefined) {
      throw unauthorized('issuing a token requires an admin wallet of this issuer')
    }

    // The attestor is any membership address with the attestor role: they sign
    // alongside rather than log into the console. Without them there is no
    // issuance, because the first reserve attestation is created by the same
    // transaction (FR-022).
    const attestor = chooseSigner(
      roster.filter((entry) => hasRole(entry.roles, ROLE.ATTESTOR)),
      input.attestor,
      'attestor',
    )
    if (attestor === undefined) {
      throw invalidInput('this issuer has no attestor in its roster; add one before issuing')
    }

    const attestedAt = input.reserve.attestedAt ?? now
    if (attestedAt > now) {
      throw invalidInput('the reserve attestation is dated in the future', { now })
    }
    // The program rejects an issuance with an already expired attestation, and
    // the token never appears at all. Saying so before two signatures is
    // cheaper.
    if (now - attestedAt > input.attestation.maxAgeSeconds) {
      throw invalidInput('the reserve attestation would already be expired at issuance', {
        attestedAt,
        now,
        maxAgeSeconds: input.attestation.maxAgeSeconds,
      })
    }

    const issuerId = new PublicKey(session.issuerId)
    const tokenIndex = await deps.chain.tokenCount(issuerId)
    if (tokenIndex === undefined) {
      throw notFound('this issuer has no IssuerConfig on chain yet')
    }

    const mint = mintPda(issuerId, tokenIndex)
    const reservation = await deps.issuance.reserve({
      issuerId: session.issuerId,
      mint: mint.toBase58(),
      symbol: input.symbol,
      name: input.name,
      decimals: input.decimals,
      at,
    })
    if (reservation.kind === 'taken') {
      // There is one number per issuer, so a taken number is not "try
      // another": naming who holds it and since when is the only useful
      // answer.
      throw invalidInput('another issuance already holds the next token number', {
        mint: mint.toBase58(),
        tokenIndex,
        symbol: reservation.holder.symbol,
        name: reservation.holder.name,
        since: reservation.since.toISOString(),
      })
    }

    const plans = await buildTokenIssuance(deps.chain.program, {
      issuerId,
      tokenIndex,
      founder: new PublicKey(founder),
      attestor: new PublicKey(attestor),
      decimals: input.decimals,
      attestationCredential: new PublicKey(input.attestation.credential),
      attestationSchema: new PublicKey(input.attestation.schema),
      treasury: new PublicKey(input.fee.treasury),
      feeBps: input.fee.bps,
      attestationMaxAge: BigInt(input.attestation.maxAgeSeconds),
      reserveCurrency: input.reserve.currency,
      policy: input.policy,
      initialSupply: toU64(input.initialSupply),
      reserveAmount: toU64(input.reserve.amount),
      reserveAttestedAt: BigInt(attestedAt),
      founderStatus: {
        tier: input.founderStatus.tier,
        jurisdiction: input.founderStatus.jurisdiction,
        denied: false,
        expiresAt: BigInt(input.founderStatus.expiresAt),
      },
      name: input.name,
      symbol: input.symbol,
      uri: input.uri,
    })

    // **One blockhash for all three.** A person signs them in one wizard
    // action, and three different lifetimes would mean the third transaction
    // goes stale before its turn to be signed comes.
    const blockhash = await deps.chain.latestBlockhash()
    const transactions = plans.map((plan) => {
      const unsigned = toUnsigned(plan, blockhash)
      const bytes = transactionBytes(unsigned.transaction)
      // The tightest constraint in the project (T018). A transaction that
      // outgrew the limit must fail here, while it is visible which one — not
      // on the network without explanation.
      if (bytes > MAX_TRANSACTION_BYTES) {
        throw internal(`${plan.step} does not fit in a transaction`, {
          bytes,
          limit: MAX_TRANSACTION_BYTES,
        })
      }
      return {
        step: unsigned.step,
        base64: unsigned.base64,
        signers: unsigned.signers.map((signer) => signer.toBase58()),
        dependsOnPrevious: unsigned.dependsOnPrevious,
        bytes,
      }
    })

    const addresses = issuanceAddresses(issuerId, tokenIndex)

    // An assembled but unsigned issuance never reaches the on-chain journal
    // (FR-018) — and it should not be there. This log line is the only thing
    // that remembers someone took the number under this name, and it is what
    // explains a taken number.
    c.get('log').info(
      { mint: addresses.mint.toBase58(), tokenIndex, symbol: input.symbol, founder, attestor },
      'issuance assembled',
    )

    return c.json({
      tokenIndex,
      mint: addresses.mint.toBase58(),
      tokenConfig: addresses.tokenConfig.toBase58(),
      policyConfig: addresses.policyConfig.toBase58(),
      attestation: addresses.attestation.toBase58(),
      extraAccountMetaList: addresses.extraAccountMetaList.toBase58(),
      founder,
      attestor,
      blockhash,
      transactions,
    } satisfies CreateTokenResponse)
  })

  return app
}
