// Holder onboarding: the queue, thawing, the issuer's own status registry
// (FR-008a, FR-008b2).
//
// **This is the project's first delegated operation (FR-035b), and it has two
// paths — exactly the two the program has.** `authority::require_routine`
// (T016) accepts either the platform's operational key within
// `delegation_mask`, or an authorised member of the membership. The route
// mirrors that: with a delegation the API signs itself and returns the
// signature; without one it returns an **unsigned** transaction for the
// member's wallet, and the console signs.
//
// The second path does not exist for symmetry. A delegation is revoked with
// one action, and if the operational key were the only one able to thaw, a
// revocation would freeze onboarding forever: the issuer would lose the
// ability to act with its own hands exactly when it decided it no longer
// trusts the platform.
//
// **The on-chain half is closed in T016, the builders in T020.** There is
// not a single rule and not a single instruction here: the route reads state,
// picks the signing path and returns the result.
import {
  buildSetHolderStatus,
  buildThawHolder,
  MAX_TRANSACTION_BYTES,
  type TxPlan,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { jurisdictionSchema, tierSchema } from '@forge/policy/model'
import { DELEGATION, hasPower, hasRole, ROLE_AUTHORISING } from '@forge/shared/api'
import { addressSchema, unixSecondsSchema } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ChainReader } from '../chain.ts'
import type { Directory } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { ApiProblem, internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import {
  decideThaw,
  HOLDER_STATES,
  type HolderRow,
  type HolderStatusFields,
  type HolderStore,
  toExpiryDate,
  toUnixSeconds,
} from '../holders.ts'
import { type OperationalSigner, SubmitError } from '../operational.ts'
import { chooseSigner } from '../signers.ts'

export interface HolderRouteDeps {
  chain: ChainReader
  directory: Directory
  holders: HolderStore
  operational: OperationalSigner
  now: () => Date
}

/**
 * How many wallets a batch accepts.
 *
 * A batch is N separate transactions, not one big one (`thaw_holder` has nine
 * accounts, and three or four of them would fit in 1232 bytes). So the bound
 * here is not in bytes but in time: twenty-five confirmations in a row is
 * tens of seconds, and a longer queue the client must split itself, while it
 * is visible where it stopped.
 */
export const MAX_BATCH_WALLETS = 25

// ─── Bodies and parameters ───────────────────────────────────────────────────

/**
 * `expiresAt` is unix seconds; `null`, zero or absent mean "no expiry".
 *
 * Zero is accepted as a synonym for absence precisely because that is how it
 * is written in the account (`HolderStatus.expires_at`, T016): a client that
 * read the on-chain record and sent it back must not be refused for reading
 * it correctly.
 */
const expirySchema = unixSecondsSchema.nullish()

export const queueHolderBodySchema = z.strictObject({
  wallet: addressSchema,
  tier: tierSchema,
  jurisdiction: jurisdictionSchema,
  expiresAt: expirySchema,
})

export const holderStatusBodySchema = z.strictObject({
  tier: tierSchema,
  jurisdiction: jurisdictionSchema,
  // An explicit field, not "absent means no": a denial is the strictest thing
  // the registry can do (FR-008a1), and it must not be liftable by omitting a
  // field.
  denied: z.boolean(),
  expiresAt: expirySchema,
})

export const thawBatchBodySchema = z.strictObject({
  wallets: z
    .array(addressSchema)
    .min(1)
    .max(MAX_BATCH_WALLETS)
    // A repeat in the list is harmless for the chain (a second thaw does
    // nothing), but in the report it would give two lines for one account —
    // and the officer would count the queue wrong.
    .refine((wallets) => new Set(wallets).size === wallets.length, 'wallets must be unique'),
})

/**
 * The signer comes as a query parameter, not a body field, and that is not
 * cosmetics.
 *
 * It is not part of the action: the action is "thaw this account", and it is
 * the same regardless of whose signature performs it. The parameter only
 * **narrows** the choice among the addresses the membership has already named
 * as authorised, and at the same time gives one shape to three handlers, one
 * of which has no body at all.
 *
 * A named signer **turns delegation off** for this request: an issuer that
 * named its own wallet said "I will sign myself", not "sign for me".
 */
export const signerQuerySchema = z.object({ signer: addressSchema.optional() })

export const holderQuerySchema = z.object({ state: z.enum(HOLDER_STATES).optional() })

// ─── Signing path ────────────────────────────────────────────────────────────

/**
 * Who signs this request — and everything needed for that.
 *
 * The blockhash sits in the path itself, not beside it: the batch's unsigned
 * transactions travel to the console in one response, and different lifetimes
 * would mean the last ones go stale while the person signs the first (the
 * same decision as for the three issuance transactions, T021).
 */
type SigningPath =
  | { readonly mode: 'delegated' }
  | { readonly mode: 'member'; readonly signer: string; readonly blockhash: string }

type OutcomeKind = 'thawed' | 'updated' | 'unsigned' | 'failed'

interface Outcome {
  readonly wallet: string
  readonly outcome: OutcomeKind
}

export function createHolderRoutes(deps: HolderRouteDeps) {
  const app = new Hono<AppEnv>()

  const body = <S extends z.ZodType>(schema: S) =>
    zValidator('json', schema, (result) => {
      if (!result.success) throw result.error
    })

  const query = <S extends z.ZodType>(schema: S) =>
    zValidator('query', schema, (result) => {
      if (!result.success) throw result.error
    })

  /**
   * A token this issuer does not have does not exist **for this session**.
   *
   * `NOT_FOUND`, not `UNAUTHORIZED`: the difference between "someone else's
   * mint" and "non-existent" would tell whoever is enumerating addresses
   * about other people's data (FR-036, SC-011).
   */
  const requireToken = async (issuerId: string, mint: string) => {
    if (!(await deps.holders.ownsToken(issuerId, mint))) {
      throw notFound('this issuer has no such token')
    }
  }

  /** Thawing and statuses are an action, not a read: an observer does not do them. */
  const requireAuthorising = (roles: number) => {
    if (!hasRole(roles, ROLE_AUTHORISING)) {
      throw unauthorized('this role cannot onboard holders')
    }
  }

  /**
   * Who signs is decided **once per request**, not per wallet: there is one
   * `IssuerConfig` per issuer, and a batch where half the accounts went by
   * delegation and half came back as transactions would be a response with no
   * way to display it.
   */
  const signingPath = async (
    issuerId: string,
    wallets: readonly string[],
    power: number,
    requested: string | undefined,
  ): Promise<SigningPath> => {
    if (requested === undefined) {
      const config = await deps.chain.issuerConfig(new PublicKey(issuerId))
      if (config === undefined) throw notFound('this issuer has no IssuerConfig on chain yet')

      // Both conditions are mandatory: a mask without a matching address means
      // the issuer delegated the power to **another** key, and signing for it
      // with ours would be exactly what FR-035a does not allow.
      if (
        config.operationalKey === deps.operational.publicKey.toBase58() &&
        hasPower(config.delegationMask, power)
      ) {
        return { mode: 'delegated' }
      }
    }

    const roster = await deps.directory.rosterFor(issuerId)
    const candidates = roster.filter(
      (entry) => hasRole(entry.roles, ROLE_AUTHORISING) && wallets.includes(entry.wallet),
    )
    const signer = chooseSigner(candidates, requested, 'signer')
    if (signer === undefined) {
      // The session has the role — `requireAuthorising` already checked it —
      // but the address is not in the membership: either the membership mirror
      // lagged, or the person logged in with another wallet. Both cases are
      // cured the same way: delegate the power, or log in with an address
      // that is in the membership.
      throw unauthorized(
        'the operational key cannot sign for this issuer, and no wallet of this session is in its roster',
        { power: powerLabel(power) },
      )
    }

    return { mode: 'member', signer, blockhash: await deps.chain.latestBlockhash() }
  }

  // ─── Queue ─────────────────────────────────────────────────────────────────

  /** Joining the queue. Does not touch the chain: an application is not yet an action. */
  app.post('/tokens/:mint/holders', body(queueHolderBodySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    requireAuthorising(session.roles)
    await requireToken(session.issuerId, mint)

    const input = c.req.valid('json')
    const queued = await deps.holders.enqueue({
      issuerId: session.issuerId,
      mint,
      wallet: input.wallet,
      tier: input.tier,
      jurisdiction: input.jurisdiction,
      expiresAt: toExpiryDate(input.expiresAt),
      at: deps.now(),
    })

    if (queued.kind === 'settled') {
      throw invalidInput('this account is already onboarded; change its status instead', {
        wallet: input.wallet,
        state: queued.row.state,
      })
    }

    return c.json({ holder: view(queued.row) })
  })

  /** The officer's queue. A read, so no role is asked for — membership is enough. */
  app.get('/tokens/:mint/holders', query(holderQuerySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    await requireToken(session.issuerId, mint)

    const rows = await deps.holders.list(session.issuerId, mint, c.req.valid('query').state)
    return c.json({ holders: rows.map(view) })
  })

  // ─── Thawing ───────────────────────────────────────────────────────────────

  /**
   * A single thaw. An error here is a request refusal, not a report line: the
   * wallet is named in the path, and "zero of one" instead of a reason would
   * mean a 200 for an action that did not happen.
   */
  app.post('/tokens/:mint/holders/:wallet/thaw', query(signerQuerySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    const wallet = addressParam(c.req.param('wallet'), 'wallet')
    requireAuthorising(session.roles)
    await requireToken(session.issuerId, mint)

    const path = await signingPath(
      session.issuerId,
      session.wallets,
      DELEGATION.THAW_HOLDER,
      c.req.valid('query').signer,
    )

    const result = await thawOne(deps, session.issuerId, mint, wallet, path)
    return c.json({ ...describe(path), ...result })
  })

  /** A batch: N transactions, a report on each. A partial refusal is visible by name. */
  app.post(
    '/tokens/:mint/holders/thaw',
    query(signerQuerySchema),
    body(thawBatchBodySchema),
    async (c) => {
      const session = c.get('session')
      const mint = addressParam(c.req.param('mint'), 'mint')
      requireAuthorising(session.roles)
      await requireToken(session.issuerId, mint)

      const path = await signingPath(
        session.issuerId,
        session.wallets,
        DELEGATION.THAW_HOLDER,
        c.req.valid('query').signer,
      )

      const results: Outcome[] = []
      for (const wallet of c.req.valid('json').wallets) {
        try {
          // Sequentially, not `Promise.all`: the delegated path signs with one
          // key, and parallel transactions of one payer with the same
          // blockhash are a race for one slot in which some vanish as
          // duplicates.
          results.push(await thawOne(deps, session.issuerId, mint, wallet, path))
        } catch (error) {
          results.push(failure(wallet, error))
        }
      }

      c.get('log').info({ mint, mode: path.mode, ...tally(results) }, 'holder thaw batch finished')
      return c.json({ ...describe(path), results })
    },
  )

  // ─── Status registry ───────────────────────────────────────────────────────

  /**
   * An update of the issuer's own registry (FR-008a, FR-008b1).
   *
   * The account stays as it was: this action freezes nothing and admits
   * nothing — it changes what **every** transfer reads. That is exactly why it
   * is separate from thawing and has its own power in the delegation mask.
   */
  app.post(
    '/tokens/:mint/holders/:wallet/status',
    query(signerQuerySchema),
    body(holderStatusBodySchema),
    async (c) => {
      const session = c.get('session')
      const mint = addressParam(c.req.param('mint'), 'mint')
      const wallet = addressParam(c.req.param('wallet'), 'wallet')
      requireAuthorising(session.roles)
      await requireToken(session.issuerId, mint)

      const input = c.req.valid('json')
      const status: HolderStatusFields = {
        tier: input.tier,
        jurisdiction: input.jurisdiction,
        denied: input.denied,
        expiresAt: input.expiresAt ?? null,
      }

      // `set_holder_status` does not create the account (T016): the record is
      // created together with the thaw, because a status without a thawed
      // account means nothing. Without this check the person would get
      // `AccountNotInitialized`.
      if (!(await deps.chain.holderStatusWritten(new PublicKey(mint), new PublicKey(wallet)))) {
        throw invalidInput('this account has no on-chain status yet; thaw it first', { wallet })
      }

      const path = await signingPath(
        session.issuerId,
        session.wallets,
        DELEGATION.SET_HOLDER_STATUS,
        c.req.valid('query').signer,
      )

      const plan = await buildSetHolderStatus(deps.chain.program, {
        issuerId: new PublicKey(session.issuerId),
        mint: new PublicKey(mint),
        wallet: new PublicKey(wallet),
        authority: authorityOf(deps, path),
        status: toBuilderStatus(status),
      })

      const dispatched = await dispatch(deps, plan, path)
      if (path.mode === 'delegated') {
        // The mirror is written **after** confirmation: a row updated in advance
        // would diverge from the chain exactly where the transaction failed.
        await deps.holders.saveStatus({
          issuerId: session.issuerId,
          mint,
          wallet,
          status,
          at: deps.now(),
        })
      }

      return c.json({
        ...describe(path),
        wallet,
        outcome: path.mode === 'delegated' ? 'updated' : 'unsigned',
        ...dispatched,
      })
    },
  )

  return app
}

// ─── A single thaw ───────────────────────────────────────────────────────────

async function thawOne(
  deps: HolderRouteDeps,
  issuerId: string,
  mint: string,
  wallet: string,
  path: SigningPath,
) {
  const mintKey = new PublicKey(mint)
  const walletKey = new PublicKey(wallet)

  // The order matters: "was the record written" is asked of the chain, and
  // that answer decides whether the transaction carries a status. The
  // database only supplies the values.
  const written = await deps.chain.holderStatusWritten(mintKey, walletKey)
  const intent = decideThaw(await deps.holders.get(issuerId, mint, wallet), written)

  if (intent.kind === 'refuse') {
    throw intent.reason === 'not-queued'
      ? notFound('this account is not in the thaw queue; add it first', { wallet })
      : invalidInput('this queue entry has no tier or jurisdiction to write', { wallet })
  }

  const authority = authorityOf(deps, path)
  const plan = await buildThawHolder(deps.chain.program, {
    issuerId: new PublicKey(issuerId),
    mint: mintKey,
    wallet: walletKey,
    // The payer and the authoriser are one address: the rent for the two
    // accounts (`HolderStatus` and `VelocityCounter`) is paid by whoever
    // signs. On the delegated path that is the platform, a direct consequence
    // of the delegation rather than a separate decision.
    payer: authority,
    authority,
    status: intent.kind === 'first' ? toBuilderStatus(intent.status) : null,
  })

  const dispatched = await dispatch(deps, plan, path)
  if (path.mode === 'delegated') {
    await deps.holders.markThawed({
      issuerId,
      mint,
      wallet,
      // The mirror gets the status only when the transaction wrote it too: a
      // repeat thaw does not touch the on-chain record (T016).
      status: intent.kind === 'first' ? intent.status : undefined,
      at: deps.now(),
    })
  }

  const outcome: OutcomeKind = path.mode === 'delegated' ? 'thawed' : 'unsigned'
  return { wallet, outcome, ...dispatched }
}

// ─── Small conversions ───────────────────────────────────────────────────────

function authorityOf(deps: HolderRouteDeps, path: SigningPath): PublicKey {
  return path.mode === 'delegated' ? deps.operational.publicKey : new PublicKey(path.signer)
}

/** Plan → a signature (delegated) or an unsigned transaction (a membership wallet). */
async function dispatch(deps: HolderRouteDeps, plan: TxPlan, path: SigningPath) {
  if (path.mode === 'member') {
    const unsigned = toUnsigned(plan, path.blockhash)
    const bytes = transactionBytes(unsigned.transaction)
    // The same check as on issuance (T021): a transaction that outgrew the
    // limit must fail here, while it is visible which one.
    if (bytes > MAX_TRANSACTION_BYTES) {
      throw internal(`${plan.step} does not fit in a transaction`, {
        bytes,
        limit: MAX_TRANSACTION_BYTES,
      })
    }

    return {
      transaction: {
        step: unsigned.step,
        base64: unsigned.base64,
        signers: unsigned.signers.map((signer) => signer.toBase58()),
        dependsOnPrevious: unsigned.dependsOnPrevious,
        bytes,
      },
    }
  }

  try {
    return { signature: await deps.operational.submit(plan) }
  } catch (error) {
    throw asProblem(error)
  }
}

/**
 * A program refusal is an answer about the state of the chain, not an API
 * failure.
 *
 * So it becomes `INVALID_INPUT` with the program's own text: "power not
 * delegated" must be shown to the person verbatim. Everything that did not
 * parse into a program code is the network, and that is `INTERNAL`.
 */
function asProblem(error: unknown): unknown {
  if (!(error instanceof SubmitError)) return error
  if (error.program === undefined) return internal(error.message, { cause: 'network' })

  return invalidInput(error.program.message, {
    program: { code: error.program.code, name: error.program.name },
  })
}

function failure(wallet: string, error: unknown): Outcome & { error: Record<string, string> } {
  // Not an `ApiProblem` — this is not the refusal of one application but a
  // broken request as a whole (malformed JSON, a database down). Swallowing
  // that into a report line would mean a 200 for a batch nothing could come
  // out of.
  if (!(error instanceof ApiProblem)) throw error

  return { wallet, outcome: 'failed', error: { code: error.code, message: error.message } }
}

function tally(results: readonly Outcome[]) {
  return {
    ok: results.filter((result) => result.outcome !== 'failed').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
  }
}

/** The shared response "header": how it was signed, and with what — for the unsigned path. */
function describe(path: SigningPath) {
  return path.mode === 'delegated'
    ? { mode: 'delegated' as const }
    : { mode: 'member' as const, signer: path.signer, blockhash: path.blockhash }
}

function view(row: HolderRow) {
  return {
    wallet: row.wallet,
    state: row.state,
    tier: row.tier,
    jurisdiction: row.jurisdiction,
    denied: row.denied,
    expiresAt: row.expiresAt === null ? null : toUnixSeconds(row.expiresAt),
    requestedAt: row.requestedAt.toISOString(),
    thawedAt: row.thawedAt === null ? null : row.thawedAt.toISOString(),
  }
}

/** The status shape the T020 builders accept: `bigint`, zero — "no expiry". */
function toBuilderStatus(status: HolderStatusFields) {
  return {
    tier: status.tier,
    jurisdiction: status.jurisdiction,
    denied: status.denied,
    expiresAt: BigInt(status.expiresAt ?? 0),
  }
}

function powerLabel(power: number): string {
  return power === DELEGATION.THAW_HOLDER ? 'THAW_HOLDER' : 'SET_HOLDER_STATUS'
}

/**
 * An address from the path is checked with the same schema as the body.
 *
 * Without this `new PublicKey('..')` throws from the depths of web3.js, and a
 * 400 turns into a 500 on the cheapest possible mistake — a typo in the
 * address.
 */
function addressParam(value: string | undefined, label: string): string {
  const parsed = addressSchema.safeParse(value)
  if (!parsed.success) throw invalidInput(`${label} is not a base58 address`)
  return parsed.data
}
