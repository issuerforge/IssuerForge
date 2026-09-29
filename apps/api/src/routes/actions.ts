// Quorum proposals: raising, approving, executing, closing (FR-019, FR-019b,
// FR-019c).
//
// **Every handler that changes state returns an unsigned transaction.** An
// action with funds is the issuer's quorum, and the platform's operational key
// has no path here at all (FR-035a) — not even as the payer of a proposal's
// rent, which the program would allow: paying would grant nothing, but it
// would widen what our key signs past the three delegated operations.
//
// **The chain decides, the route only says so earlier.** Each pre-check below
// mirrors a refusal the program makes — a proposal past its term, a
// duplicate approval, a quorum that is not there — and exists so that the
// person learns it before paying for a transaction, not from a devnet error.
// The program checks all of it again; nothing here is the authority.
//
// **Who signs is chosen from this session's authorising wallets**, the same
// rule as the holder routes (`signers.ts`): the query parameter narrows, it
// never names an address the membership has not.
import {
  actionProposalPda,
  buildApproveAction,
  buildCloseActionProposal,
  buildProposeAction,
  buildSeize,
  buildSetPolicy,
  issuerConfigPda,
  MAX_TRANSACTION_BYTES,
  type ProposedActionInput,
  type TxPlan,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { hasRole, ROLE_AUTHORISING, type Session } from '@forge/shared/api'
import { addressSchema, fromU64, toU64 } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import type { z } from 'zod'
import {
  type ActionReader,
  isFinished,
  type ProposalView,
  type QuorumView,
  randomNonce,
  type Standing,
  standing,
} from '../actions.ts'
import type { ChainReader } from '../chain.ts'
import {
  type ActionTransactionResponse,
  type ProposalResponse,
  type ProposeActionResponse,
  proposeActionBodySchema,
  signerQuerySchema,
} from '../contracts/actions.ts'
import type { Directory } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import { chooseSigner } from '../signers.ts'

export {
  type ActionTransactionResponse,
  type ProposalResponse,
  type ProposeActionBody,
  type ProposeActionResponse,
  proposeActionBodySchema,
} from '../contracts/actions.ts'

export interface ActionRouteDeps {
  chain: ChainReader
  actions: ActionReader
  directory: Directory
  now: () => Date
  /** The proposal's seed number. Swapped in tests so the address is predictable. */
  nonce?: () => bigint
}

/** `MAX_MEMBERS` in `constants.rs`: the length of `ActionProposal.approvals`. */
export const MAX_APPROVALS = 8

export function createActionRoutes(deps: ActionRouteDeps) {
  const app = new Hono<AppEnv>()
  const nextNonce = deps.nonce ?? randomNonce
  const unixNow = () => Math.floor(deps.now().getTime() / 1000)

  const body = <S extends z.ZodType>(schema: S) =>
    zValidator('json', schema, (result) => {
      if (!result.success) throw result.error
    })

  const query = <S extends z.ZodType>(schema: S) =>
    zValidator('query', schema, (result) => {
      if (!result.success) throw result.error
    })

  const ownConfig = (session: Session) =>
    issuerConfigPda(new PublicKey(session.issuerId)).toBase58()

  /**
   * A token of another issuer does not exist for this session — `NOT_FOUND`,
   * not `UNAUTHORIZED`, for the same reason as the holder routes (SC-011).
   * Ownership is read from `TokenConfig.issuer` on chain, the same field the
   * program compares.
   */
  const requireToken = async (session: Session, mint: string) => {
    const token = await deps.actions.token(new PublicKey(mint))
    if (token === undefined || token.issuerConfig !== ownConfig(session)) {
      throw notFound('this issuer has no such token')
    }
    return token
  }

  const requireProposal = async (session: Session, id: string) => {
    const view = await deps.actions.proposal(new PublicKey(id))
    if (view === undefined || view.issuerConfig !== ownConfig(session)) {
      throw notFound('this issuer has no such proposal')
    }
    return view
  }

  const requireQuorum = async (session: Session) => {
    const quorum = await deps.actions.quorum(new PublicKey(session.issuerId))
    if (quorum === undefined) throw notFound('this issuer has no IssuerConfig on chain yet')
    return quorum
  }

  /**
   * The signing wallet: one of this session's, authorising in the roster
   * **and** on chain.
   *
   * The second check is not redundant. The roster is a mirror, and a wallet
   * removed on chain a minute ago is still in it; the program reads the
   * chain and would refuse with `NotAnAuthorisingSigner` after the person
   * had already signed.
   */
  const sessionSigner = async (
    session: Session,
    quorum: QuorumView,
    requested: string | undefined,
  ): Promise<string> => {
    if (!hasRole(session.roles, ROLE_AUTHORISING)) {
      throw unauthorized('this role cannot take part in the quorum')
    }
    const roster = await deps.directory.rosterFor(session.issuerId)
    const signer = chooseSigner(
      roster.filter(
        (entry) => hasRole(entry.roles, ROLE_AUTHORISING) && session.wallets.includes(entry.wallet),
      ),
      requested,
      'signer',
    )
    if (signer === undefined) {
      throw unauthorized('no wallet of this session is an authorising member of this issuer')
    }
    const onChain = quorum.members.find((member) => member.wallet === signer)
    if (onChain === undefined || !hasRole(onChain.roles, ROLE_AUTHORISING)) {
      throw invalidInput('this wallet is not an authorising member on chain', { signer })
    }
    return signer
  }

  const respond = async (
    plan: TxPlan,
    proposal: string,
    signer: string,
  ): Promise<ActionTransactionResponse> => {
    const blockhash = await deps.chain.latestBlockhash()
    const unsigned = toUnsigned(plan, blockhash)
    const bytes = transactionBytes(unsigned.transaction)
    if (bytes > MAX_TRANSACTION_BYTES) {
      throw internal(`${plan.step} does not fit in a transaction`, {
        bytes,
        limit: MAX_TRANSACTION_BYTES,
      })
    }
    return {
      proposal,
      signer,
      blockhash,
      transaction: {
        step: unsigned.step,
        base64: unsigned.base64,
        signers: unsigned.signers.map((key) => key.toBase58()),
        dependsOnPrevious: unsigned.dependsOnPrevious,
        bytes,
      },
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** The token's open proposals. A read: membership is enough, no role asked. */
  app.get('/tokens/:mint/actions', async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    await requireToken(session, mint)

    const [views, quorum] = await Promise.all([
      deps.actions.proposals(new PublicKey(mint)),
      requireQuorum(session),
    ])
    const now = unixNow()
    return c.json({ proposals: views.map((view) => present(view, standing(view, quorum, now))) })
  })

  /**
   * One proposal with its body. The body is what an approver signs for, so
   * it comes from the proposing transaction and is checked against the
   * account's digest before it is shown (`ActionReader.body`).
   */
  app.get('/actions/:id', async (c) => {
    const session = c.get('session')
    const id = addressParam(c.req.param('id'), 'proposal')
    const view = await requireProposal(session, id)
    const quorum = await requireQuorum(session)

    const found = await deps.actions.body(view)
    if (found === undefined) throw bodyMissing(view)

    return c.json({
      proposal: present(view, standing(view, quorum, unixNow())),
      body: presentBody(found),
    })
  })

  // ─── Writes ────────────────────────────────────────────────────────────────

  /** Raising a proposal. The proposer's signature is its first approval, and the proposer pays. */
  app.post(
    '/tokens/:mint/actions',
    query(signerQuerySchema),
    body(proposeActionBodySchema),
    async (c) => {
      const session = c.get('session')
      const mint = addressParam(c.req.param('mint'), 'mint')
      const token = await requireToken(session, mint)
      const quorum = await requireQuorum(session)
      const proposer = await sessionSigner(session, quorum, c.req.valid('query').signer)
      const input = c.req.valid('json').action

      const action: ProposedActionInput =
        input.kind === 'set-policy'
          ? // Read here, not typed by the person: `set_policy` accepts exactly
            // the next version, and the proposal is bound to it by its digest.
            { kind: 'set-policy', version: token.policyVersion + 1, policy: input.policy }
          : {
              kind: 'seize',
              tokenAccount: new PublicKey(input.tokenAccount),
              amount: toU64(input.amount),
              reason: input.reason,
            }
      const nonce = nextNonce()
      const plan = await buildProposeAction(deps.chain.program, {
        issuerId: new PublicKey(session.issuerId),
        mint: new PublicKey(mint),
        nonce,
        termSeconds: c.req.valid('json').termSeconds,
        action,
        payer: new PublicKey(proposer),
        proposer: new PublicKey(proposer),
      })
      const proposal = actionProposalPda(new PublicKey(mint), nonce).toBase58()

      c.get('log').info({ mint, proposal, kind: action.kind, proposer }, 'proposal assembled')
      return c.json({
        ...(await respond(plan, proposal, proposer)),
        nonce: fromU64(nonce),
        ...(action.kind === 'set-policy' ? { version: action.version } : {}),
      } satisfies ProposeActionResponse)
    },
  )

  app.post('/actions/:id/approve', query(signerQuerySchema), async (c) => {
    const session = c.get('session')
    const id = addressParam(c.req.param('id'), 'proposal')
    const view = await requireProposal(session, id)
    const quorum = await requireQuorum(session)
    const approver = await sessionSigner(session, quorum, c.req.valid('query').signer)
    const current = standing(view, quorum, unixNow())

    if (isFinished(current.state)) throw over(current)
    if (current.state === 'blocked') {
      // The program would take the signature — and the proposal would stay
      // unexecutable, because the lapsed approval cannot be withdrawn.
      throw invalidInput('this proposal cannot reach its quorum: raise a new one', {
        lapsed: current.lapsed,
      })
    }
    if (view.approvals.includes(approver)) {
      throw invalidInput('this wallet has already approved the proposal', { approver })
    }
    if (view.approvals.length >= MAX_APPROVALS) {
      throw invalidInput('this proposal has no room for another approval')
    }

    const plan = await buildApproveAction(deps.chain.program, {
      issuerId: new PublicKey(session.issuerId),
      proposal: new PublicKey(id),
      approver: new PublicKey(approver),
    })
    return c.json(await respond(plan, id, approver))
  })

  /**
   * Execution: `set_policy` on the deferred path, or `seize`.
   *
   * Anyone of the session's authorising wallets may send it and pay the rent
   * — of the new policy version, or of the vault on a token's first seizure.
   * The authority is the proposal's quorum, and this signature adds nothing
   * to it.
   */
  app.post('/actions/:id/execute', query(signerQuerySchema), async (c) => {
    const session = c.get('session')
    const id = addressParam(c.req.param('id'), 'proposal')
    const view = await requireProposal(session, id)
    const quorum = await requireQuorum(session)
    const payer = await sessionSigner(session, quorum, c.req.valid('query').signer)
    const current = standing(view, quorum, unixNow())

    if (current.state !== 'ready') {
      throw invalidInput(`this proposal is ${current.state}, not ready to execute`, {
        state: current.state,
        required: current.required,
        counted: current.counted,
        lapsed: current.lapsed,
      })
    }

    const action = view.action
    if (action.kind === 'seize') {
      // Everything the seizure needs is in the account, approvers included:
      // they ride in the instruction so the journal can name them (FR-019c).
      const plan = await buildSeize(deps.chain.program, {
        issuerId: new PublicKey(session.issuerId),
        mint: new PublicKey(view.mint),
        proposal: new PublicKey(id),
        tokenAccount: new PublicKey(action.tokenAccount),
        amount: action.amount,
        reason: action.reason,
        approvers: view.approvals.map((wallet) => new PublicKey(wallet)),
        payer: new PublicKey(payer),
      })
      c.get('log').info(
        { proposal: id, tokenAccount: action.tokenAccount, amount: fromU64(action.amount), payer },
        'seizure assembled',
      )
      return c.json(await respond(plan, id, payer))
    }

    const token = await requireToken(session, view.mint)
    if (token.policyVersion + 1 !== action.version) {
      // Another change landed first — by the immediate path, or by another
      // proposal for the same number. The digest binds this one to a version
      // that is no longer next, so it can only lapse.
      throw invalidInput('the policy has moved on since this proposal was raised', {
        proposed: action.version,
        current: token.policyVersion,
      })
    }

    const found = await deps.actions.body(view)
    // `body()` returns only a body that matches the account, so a policy
    // proposal cannot come back as anything else.
    if (found?.kind !== 'set-policy') throw bodyMissing(view)

    const plan = await buildSetPolicy(deps.chain.program, {
      issuerId: new PublicKey(session.issuerId),
      mint: new PublicKey(view.mint),
      version: found.version,
      policy: found.policy,
      payer: new PublicKey(payer),
      quorum: { kind: 'proposal', proposal: new PublicKey(id) },
    })

    c.get('log').info({ proposal: id, version: found.version, payer }, 'execution assembled')
    return c.json(await respond(plan, id, payer))
  })

  /** Returning the rent of a finished proposal to whoever paid it. */
  app.post('/actions/:id/close', query(signerQuerySchema), async (c) => {
    const session = c.get('session')
    const id = addressParam(c.req.param('id'), 'proposal')
    const view = await requireProposal(session, id)
    const quorum = await requireQuorum(session)
    const member = await sessionSigner(session, quorum, c.req.valid('query').signer)
    const current = standing(view, quorum, unixNow())

    if (!isFinished(current.state)) {
      // Closing a live proposal would be a revocation, and FR-019b gives
      // revocation to the clock, not to one member.
      throw invalidInput('a live proposal cannot be closed; it lapses at its term', {
        expiresAt: view.expiresAt,
      })
    }

    const plan = await buildCloseActionProposal(deps.chain.program, {
      issuerId: new PublicKey(session.issuerId),
      proposal: new PublicKey(id),
      rentRecipient: new PublicKey(view.payer),
      member: new PublicKey(member),
    })
    return c.json(await respond(plan, id, member))
  })

  return app
}

// ─── Small conversions ───────────────────────────────────────────────────────

function present(view: ProposalView, current: Standing): ProposalResponse {
  return {
    address: view.address,
    mint: view.mint,
    nonce: fromU64(view.nonce),
    payer: view.payer,
    action:
      view.action.kind === 'seize'
        ? { ...view.action, amount: fromU64(view.action.amount) }
        : view.action,
    approvals: [...view.approvals],
    state: current.state,
    required: current.required,
    counted: current.counted,
    lapsed: [...current.lapsed],
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    executedAt: view.executedAt,
  }
}

/** A body as the response carries it: addresses in base58, amounts as u64 strings. */
function presentBody(body: ProposedActionInput) {
  switch (body.kind) {
    case 'set-policy':
      return { kind: body.kind, policy: body.policy }
    case 'seize':
      return {
        kind: body.kind,
        tokenAccount: body.tokenAccount.toBase58(),
        amount: fromU64(body.amount),
        reason: body.reason,
      }
  }
}

function over(current: Standing) {
  return invalidInput(`this proposal is ${current.state}`, { state: current.state })
}

/**
 * The account exists, but no transaction the node still has carries a body
 * that matches its digest. That is the node's history, not the request: a
 * pruned RPC, or an index that has not caught up.
 */
function bodyMissing(view: ProposalView) {
  return internal('the proposing transaction is not available from the node', {
    proposal: view.address,
    cause: 'history',
  })
}

/** The same guard as in the holder and journal routes: a typo in the path is a 400, not a 500. */
function addressParam(value: string | undefined, label: string): string {
  const parsed = addressSchema.safeParse(value)
  if (!parsed.success) throw invalidInput(`${label} is not a base58 address`)
  return parsed.data
}
