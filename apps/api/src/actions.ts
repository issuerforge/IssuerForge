// Reading quorum proposals from the chain, and the pure decisions made over
// them (FR-019b, FR-019c).
//
// **The chain, not the mirror.** A proposal decides whether an action with
// funds may run, and the program reads it at the moment of the action; a
// console that showed "ready" from a mirror one confirmation behind would ask
// a person to pay for a transaction the program then refuses. So every read
// here goes to the network, and the database has no `proposals` table.
//
// **A policy's body is not in the account.** `ActionProposal` keeps a digest
// of the rules; the rules themselves are in the data of the `propose_action`
// that created it. `body()` reads that transaction back and **checks the
// digest against the account** before returning anything — the rules an
// approver is shown must be exactly the ones the program will compare
// against, not whatever instruction happened to touch the address. A
// seizure's body is in the account whole, and `body()` reads it from there.
//
// The same shape as `chain.ts`: an interface plus a factory from a ready
// connection, so the routes are tested with no node.
import {
  type ComplianceReasonInput,
  decodeProposedAction,
  type ForgeProgram,
  fromReason,
  issuerConfigPda,
  PROGRAM_ID,
  type ProposedActionInput,
  tokenConfigPda,
} from '@forge/chain'
import { rulesHash, toHex } from '@forge/policy/layout'
import { hasRole, ROLE_AUTHORISING } from '@forge/shared/api'
import { type Connection, PublicKey } from '@solana/web3.js'

/** What a proposal route needs to know about a token. */
export interface TokenView {
  /** The `IssuerConfig` address the token belongs to — compared, never trusted from the request. */
  readonly issuerConfig: string
  readonly policyVersion: number
}

/** The membership as the program will read it at execution — not the database mirror. */
export interface QuorumView {
  readonly quorumN: number
  readonly members: readonly { readonly wallet: string; readonly roles: number }[]
}

export type ProposalActionView =
  | {
      readonly kind: 'set-policy'
      readonly version: number
      /** Hex of the sha256 the program keeps in place of the rules. */
      readonly rulesHash: string
      readonly reason: ComplianceReasonInput
    }
  | {
      readonly kind: 'seize'
      readonly tokenAccount: string
      readonly amount: bigint
      readonly reason: ComplianceReasonInput
    }
  // Two members, not one with `kind: 'pause' | 'resume'`: TypeScript does
  // not narrow such a member out of the union, and every caller past a
  // pause branch would lose `version` and `amount`.
  | { readonly kind: 'pause'; readonly reason: ComplianceReasonInput }
  | { readonly kind: 'resume'; readonly reason: ComplianceReasonInput }

export interface ProposalView {
  readonly address: string
  readonly mint: string
  readonly issuerConfig: string
  readonly payer: string
  readonly nonce: bigint
  readonly action: ProposalActionView
  /** In the order they were given; `[0]` is the proposer. */
  readonly approvals: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number
  /** `null` rather than the account's zero: zero would read as a moment. */
  readonly executedAt: number | null
}

export interface ActionReader {
  /** `undefined` — there is no `TokenConfig` for this mint. */
  token(mint: PublicKey): Promise<TokenView | undefined>
  /** `undefined` — there is no `IssuerConfig` on the network. */
  quorum(issuerId: PublicKey): Promise<QuorumView | undefined>
  /** Every proposal still open on chain for the token. Closed ones are gone with their rent. */
  proposals(mint: PublicKey): Promise<ProposalView[]>
  proposal(address: PublicKey): Promise<ProposalView | undefined>
  /**
   * The full body, from the proposing transaction.
   *
   * `undefined` — no successful `propose_action` at this address carries a
   * body that matches the account. That is a gap in the node's history (a
   * pruned RPC), not something to guess around.
   */
  body(proposal: ProposalView): Promise<ProposedActionInput | undefined>
}

/**
 * How far back `body()` looks.
 *
 * A proposal sees at most eight approvals, one execution and one close, so
 * its history is a dozen signatures. The limit exists so that an address
 * someone spammed with failed transactions cannot turn one read into a
 * thousand.
 */
export const PROPOSAL_HISTORY_LIMIT = 50

/** Anchor's shape of the stored `ActionKind`: exactly one key is present. */
type StoredAction = {
  setPolicy?: { version: number; rulesHash: number[]; reason: StoredReason }
  seize?: {
    tokenAccount: PublicKey
    amount: { toString(): string }
    reason: StoredReason
  }
  pause?: { reason: StoredReason }
  resume?: { reason: StoredReason }
  setDelegation?: object
}

type StoredReason = { code: number; caseRef: number[] }

function toActionView(address: PublicKey, action: StoredAction): ProposalActionView {
  if (action.setPolicy !== undefined) {
    return {
      kind: 'set-policy',
      version: action.setPolicy.version,
      rulesHash: toHex(Uint8Array.from(action.setPolicy.rulesHash)),
      reason: fromReason(action.setPolicy.reason),
    }
  }
  if (action.seize !== undefined) {
    return {
      kind: 'seize',
      tokenAccount: action.seize.tokenAccount.toBase58(),
      amount: BigInt(action.seize.amount.toString()),
      reason: fromReason(action.seize.reason),
    }
  }
  if (action.pause !== undefined) {
    return { kind: 'pause', reason: fromReason(action.pause.reason) }
  }
  if (action.resume !== undefined) {
    return { kind: 'resume', reason: fromReason(action.resume.reason) }
  }
  // A kind appended to the program before this line was written: refused
  // rather than shown as one of the kinds above.
  throw new TypeError(`unknown action kind at ${address.toBase58()}`)
}

type RawProposal = {
  /** The mint for a token's action, the issuer's config for the issuer's own. */
  scope: PublicKey
  issuer: PublicKey
  payer: PublicKey
  nonce: { toString(): string }
  action: StoredAction
  approvals: PublicKey[]
  approvalCount: number
  createdAt: { toNumber(): number }
  expiresAt: { toNumber(): number }
  executedAt: { toNumber(): number; isZero(): boolean }
}

function isIssuerScoped(action: StoredAction): boolean {
  return action.setDelegation !== undefined
}

function toView(address: PublicKey, raw: RawProposal): ProposalView {
  return {
    address: address.toBase58(),
    mint: raw.scope.toBase58(),
    issuerConfig: raw.issuer.toBase58(),
    payer: raw.payer.toBase58(),
    nonce: BigInt(raw.nonce.toString()),
    action: toActionView(address, raw.action),
    approvals: raw.approvals.slice(0, raw.approvalCount).map((wallet) => wallet.toBase58()),
    createdAt: raw.createdAt.toNumber(),
    expiresAt: raw.expiresAt.toNumber(),
    executedAt: raw.executedAt.isZero() ? null : raw.executedAt.toNumber(),
  }
}

/** Whether a decoded body is the one the account committed to. */
export function bodyMatches(view: ProposalView, body: ProposedActionInput): boolean {
  const stored = view.action
  switch (body.kind) {
    case 'set-policy':
      return (
        stored.kind === 'set-policy' &&
        body.version === stored.version &&
        toHex(rulesHash(body.policy)) === stored.rulesHash &&
        body.reason.code === stored.reason.code &&
        body.reason.caseRef === stored.reason.caseRef
      )
    case 'seize':
      return (
        stored.kind === 'seize' &&
        body.tokenAccount.toBase58() === stored.tokenAccount &&
        body.amount === stored.amount &&
        body.reason.code === stored.reason.code &&
        body.reason.caseRef === stored.reason.caseRef
      )
    case 'pause':
    case 'resume':
      return (
        stored.kind === body.kind &&
        body.reason.code === stored.reason.code &&
        body.reason.caseRef === stored.reason.caseRef
      )
  }
}

export function createActionReader(connection: Connection, program: ForgeProgram): ActionReader {
  return {
    async token(mint) {
      const config = await program.account.tokenConfig.fetchNullable(tokenConfigPda(mint))
      if (config === null) return undefined
      return { issuerConfig: config.issuer.toBase58(), policyVersion: config.policyVersion }
    },

    async quorum(issuerId) {
      const config = await program.account.issuerConfig.fetchNullable(issuerConfigPda(issuerId))
      if (config === null) return undefined
      return {
        quorumN: config.quorumN,
        members: config.members
          .filter((member) => member.roles !== 0)
          .map((member) => ({ wallet: member.wallet.toBase58(), roles: member.roles })),
      }
    },

    async proposals(mint) {
      // `scope` is the first field, right after the eight-byte discriminator,
      // and for a token's action it is the mint; `all()` adds the
      // discriminator filter itself.
      const found = await program.account.actionProposal.all([
        { memcmp: { offset: 8, bytes: mint.toBase58() } },
      ])
      return found
        .map(({ publicKey, account }) => toView(publicKey, account as RawProposal))
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    async proposal(address) {
      const raw = (await program.account.actionProposal.fetchNullable(
        address,
      )) as RawProposal | null
      // An action on the issuer itself (a delegation change, T030) has no
      // token, and these routes are a token's: to them it does not exist.
      if (raw === null || isIssuerScoped(raw.action)) return undefined
      return toView(address, raw)
    },

    async body(view) {
      // The account holds a seizure and a pause whole; there is no
      // transaction to read.
      if (view.action.kind === 'seize') {
        return {
          kind: 'seize',
          tokenAccount: new PublicKey(view.action.tokenAccount),
          amount: view.action.amount,
          reason: view.action.reason,
        }
      }
      if (view.action.kind === 'pause' || view.action.kind === 'resume') {
        return { kind: view.action.kind, reason: view.action.reason }
      }

      const history = await connection.getSignaturesForAddress(new PublicKey(view.address), {
        limit: PROPOSAL_HISTORY_LIMIT,
      })

      // Newest first, so that an address reused after a close answers with
      // the proposal that lives there now, not the one that lived there once.
      for (const entry of history) {
        if (entry.err !== null) continue
        const tx = await connection.getTransaction(entry.signature, {
          maxSupportedTransactionVersion: 0,
        })
        if (tx === null) continue

        const keys = tx.transaction.message.getAccountKeys({
          accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
        })
        for (const instruction of tx.transaction.message.compiledInstructions) {
          if (!keys.get(instruction.programIdIndex)?.equals(PROGRAM_ID)) continue
          const decoded = decodeProposedAction(instruction.data)
          if (decoded === undefined || decoded.nonce !== view.nonce) continue
          if (bodyMatches(view, decoded.action)) return decoded.action
        }
      }
      return undefined
    },
  }
}

// ─── Pure decisions ──────────────────────────────────────────────────────────

/**
 * Where a proposal stands, computed the way the program will compute it.
 *
 * - `executed` / `expired` — over; only closing is left.
 * - `blocked` — live, but an approval belongs to a wallet that no longer holds
 *   an authorising role. `quorum::check` refuses the **whole** list then
 *   (`NotAnAuthorisingSigner`), and an approval cannot be withdrawn, so the
 *   proposal can only lapse. Showing it as "one short" would ask for a
 *   signature that cannot help.
 * - `ready` — live, every approval counts, and there are at least `quorumN`.
 * - `open` — live and still gathering.
 *
 * The clock is the server's, not the cluster's: the two differ by seconds,
 * and the program remains the authority at the boundary. What this gets
 * wrong for a few seconds around `expiresAt` is a label, not an action.
 */
export type ProposalState = 'open' | 'ready' | 'blocked' | 'executed' | 'expired'

export interface Standing {
  readonly state: ProposalState
  readonly required: number
  /** Approvals by wallets that still hold an authorising role. */
  readonly counted: number
  /** Approvals by wallets that no longer do — why a proposal is `blocked`. */
  readonly lapsed: readonly string[]
}

export function standing(view: ProposalView, quorum: QuorumView, now: number): Standing {
  const authorising = new Set(
    quorum.members
      .filter((member) => hasRole(member.roles, ROLE_AUTHORISING))
      .map((member) => member.wallet),
  )
  const lapsed = view.approvals.filter((wallet) => !authorising.has(wallet))
  const counted = view.approvals.length - lapsed.length

  const state: ProposalState =
    view.executedAt !== null
      ? 'executed'
      : now > view.expiresAt
        ? 'expired'
        : lapsed.length > 0
          ? 'blocked'
          : counted >= quorum.quorumN
            ? 'ready'
            : 'open'

  return { state, required: quorum.quorumN, counted, lapsed }
}

/** Whether the program's `closable` would pass. */
export const isFinished = (state: ProposalState): boolean =>
  state === 'executed' || state === 'expired'

/**
 * A random `u64` for the proposal's seeds.
 *
 * Random rather than counted, the same reason as `RedemptionEscrow.request_id`:
 * two officers raising proposals in the same minute must not race for the
 * next number and have one of them fail on an existing account.
 */
export function randomNonce(): bigint {
  const [value] = crypto.getRandomValues(new BigUint64Array(1))
  if (value === undefined) throw new Error('no random value')
  return value
}
