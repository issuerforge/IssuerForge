// What the platform's operational key may do for this issuer, and changing
// it (FR-035, FR-035b).
//
// **Revocation is one action by one admin.** The program lets a single admin
// narrow the mask of the same key (`delegation::require_change_authorised`):
// revocation is the action of the hour a key leaks, and it grants nobody
// anything. The route assembles exactly that — the immediate path, the admin
// as the only member named — and nothing else may come out of it: the mask is
// computed here from the chain and can only lose bits.
//
// **A grant or a rotation is a proposal.** It hands the platform a power over
// the issuer's holders, so it takes the quorum. The immediate quorum path
// needs two members signing the same bytes, which two people in two sessions
// cannot do; the proposal is raised here and gathered on the same proposal
// page as a token's actions (`/api/actions/:id`).
//
// **Every handler returns an unsigned transaction.** The platform's key has no
// path here at all — not even as the payer. A key that could pay for changing
// its own powers would be one step from signing them.
import {
  buildProposeDelegation,
  buildSetDelegation,
  delegationProposalPda,
  issuerConfigPda,
  MAX_TRANSACTION_BYTES,
  type TxPlan,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import {
  DELEGATION,
  hasRole,
  type PowerName,
  powerNames,
  ROLE,
  ROLE_AUTHORISING,
  type Session,
} from '@forge/shared/api'
import { fromU64 } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import type { z } from 'zod'
import { type ActionReader, type ProposalView, randomNonce, standing } from '../actions.ts'
import type { ChainReader } from '../chain.ts'
import { signerQuerySchema } from '../contracts/actions.ts'
import {
  type DelegationResponse,
  type ProposeDelegationResponse,
  proposeDelegationBodySchema,
  type RevokeResponse,
  revokeBodySchema,
} from '../contracts/delegation.ts'
import { type DelegationStore, HISTORY_LIMIT } from '../delegation.ts'
import type { Directory } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import type { OperationalSigner } from '../operational.ts'
import { chooseSigner } from '../signers.ts'
import { presentProposal } from './actions.ts'

export interface DelegationRouteDeps {
  chain: ChainReader
  actions: ActionReader
  directory: Directory
  delegations: DelegationStore
  operational: Pick<OperationalSigner, 'publicKey'>
  now: () => Date
  /** The proposal's seed number. Swapped in tests so the address is predictable. */
  nonce?: () => bigint
}

export function createDelegationRoutes(deps: DelegationRouteDeps) {
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

  const requireConfig = async (session: Session) => {
    const config = await deps.chain.issuerConfig(new PublicKey(session.issuerId))
    if (config === undefined) throw notFound('this issuer has no IssuerConfig on chain yet')
    return config
  }

  /**
   * A wallet of this session holding `role` in the roster **and** on chain —
   * the second because the roster is a mirror and the program reads the
   * chain, the same rule as the quorum routes.
   */
  const memberSigner = async (
    session: Session,
    role: number,
    label: string,
    requested: string | undefined,
  ) => {
    if (!hasRole(session.roles, role)) {
      throw unauthorized(
        `this role cannot ${label === 'admin' ? 'revoke a delegation' : 'raise a proposal'}`,
      )
    }
    const roster = await deps.directory.rosterFor(session.issuerId)
    const signer = chooseSigner(
      roster.filter(
        (entry) => hasRole(entry.roles, role) && session.wallets.includes(entry.wallet),
      ),
      requested,
      label,
    )
    if (signer === undefined) {
      throw unauthorized(`no wallet of this session is an ${label} of this issuer`)
    }
    const quorum = await deps.actions.quorum(new PublicKey(session.issuerId))
    const onChain = quorum?.members.find((member) => member.wallet === signer)
    if (onChain === undefined || !hasRole(onChain.roles, role)) {
      throw invalidInput(`this wallet is not an ${label} on chain`, { [label]: signer })
    }
    return signer
  }

  const unsigned = async (plan: TxPlan) => {
    const blockhash = await deps.chain.latestBlockhash()
    const assembled = toUnsigned(plan, blockhash)
    const bytes = transactionBytes(assembled.transaction)
    if (bytes > MAX_TRANSACTION_BYTES) {
      throw internal(`${plan.step} does not fit in a transaction`, {
        bytes,
        limit: MAX_TRANSACTION_BYTES,
      })
    }
    return {
      blockhash,
      transaction: {
        step: assembled.step,
        base64: assembled.base64,
        signers: assembled.signers.map((key) => key.toBase58()),
        dependsOnPrevious: assembled.dependsOnPrevious,
        bytes,
      },
    }
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  /** The delegation as the chain has it, the issuer's proposals, and the history. A read. */
  app.get('/issuer/delegation', async (c) => {
    const session = c.get('session')
    const config = await requireConfig(session)
    const [views, quorum, history] = await Promise.all([
      deps.actions.proposals(issuerConfigPda(new PublicKey(session.issuerId))),
      deps.actions.quorum(new PublicKey(session.issuerId)),
      deps.delegations.history(session.issuerId, HISTORY_LIMIT),
    ])
    if (quorum === undefined) throw notFound('this issuer has no IssuerConfig on chain yet')

    const now = unixNow()
    return c.json({
      operationalKey: config.operationalKey,
      mask: config.delegationMask,
      powers: powerNames(config.delegationMask),
      platformKey: deps.operational.publicKey.toBase58(),
      proposals: views
        .filter((view: ProposalView) => view.action.kind === 'set-delegation')
        .map((view) => presentProposal(view, standing(view, quorum, now))),
      history: history.map((row) => ({ ...row, signers: [...row.signers] })),
    } satisfies DelegationResponse)
  })

  // ─── Revoke: one admin, now ────────────────────────────────────────────────

  app.post(
    '/issuer/delegation/revoke',
    query(signerQuerySchema),
    body(revokeBodySchema),
    async (c) => {
      const session = c.get('session')
      const admin = await memberSigner(session, ROLE.ADMIN, 'admin', c.req.valid('query').signer)
      const config = await requireConfig(session)

      const named = c.req.valid('json').powers as PowerName[]
      const notHeld = named.filter((power) => (config.delegationMask & DELEGATION[power]) === 0)
      if (notHeld.length > 0) {
        // The program would refuse the unchanged part as `DelegationUnchanged`
        // only if nothing changed; a request that names a power the key does
        // not hold is a stale screen, and it is said so rather than quietly
        // revoking the rest.
        throw invalidInput('the operational key does not hold these powers', {
          notHeld,
          holds: powerNames(config.delegationMask),
        })
      }
      const removed = named.reduce((bits, power) => bits | DELEGATION[power], 0)
      const mask = config.delegationMask & ~removed

      const plan = await buildSetDelegation(deps.chain.program, {
        issuerId: new PublicKey(session.issuerId),
        // The same key: a different key is a rotation, and a rotation takes
        // the quorum. Kept from the chain, never from the request.
        operationalKey: new PublicKey(config.operationalKey),
        mask,
        payer: new PublicKey(admin),
        quorum: { kind: 'immediate', signers: [new PublicKey(admin)] },
      })

      c.get('log').info(
        { issuerId: session.issuerId, from: config.delegationMask, to: mask, admin },
        'revocation assembled',
      )
      return c.json({ signer: admin, mask, ...(await unsigned(plan)) } satisfies RevokeResponse)
    },
  )

  // ─── Grant or rotate: a proposal for the quorum ────────────────────────────

  app.post(
    '/issuer/delegation/proposals',
    query(signerQuerySchema),
    body(proposeDelegationBodySchema),
    async (c) => {
      const session = c.get('session')
      const proposer = await memberSigner(
        session,
        ROLE_AUTHORISING,
        'authorising member',
        c.req.valid('query').signer,
      )
      const config = await requireConfig(session)
      const input = c.req.valid('json')

      if (input.operationalKey === config.operationalKey && input.mask === config.delegationMask) {
        throw invalidInput('this is the delegation as it already stands')
      }

      const nonce = nextNonce()
      const issuerId = new PublicKey(session.issuerId)
      const plan = await buildProposeDelegation(deps.chain.program, {
        issuerId,
        operationalKey: new PublicKey(input.operationalKey),
        mask: input.mask,
        nonce,
        termSeconds: input.termSeconds,
        payer: new PublicKey(proposer),
        proposer: new PublicKey(proposer),
      })
      const proposal = delegationProposalPda(issuerId, nonce).toBase58()

      c.get('log').info(
        { issuerId: session.issuerId, proposal, to: input.mask, proposer },
        'delegation proposal assembled',
      )
      return c.json({
        proposal,
        signer: proposer,
        nonce: fromU64(nonce),
        ...(await unsigned(plan)),
      } satisfies ProposeDelegationResponse)
    },
  )

  return app
}
