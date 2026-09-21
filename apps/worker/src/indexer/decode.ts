// From a transaction view to what the database gets: the events of
// `@forge/shared/events` and the changes to the mirror tables.
//
// **There are no events in the logs to parse.** The program writes neither
// `emit!` nor `msg!`, so an event here is reconstructed from the instruction
// that caused it: its discriminator names it, its data carries the
// arguments, its account list carries the parties. That is deliberate on the
// program's side (the hook's compute budget, SC-003a) and it fixes the shape
// of this file — a table of instruction names, one decoder each.
//
// Transfers are not the program's instructions at all but the token
// program's: every transfer of a mint with a hook is a Token-2022
// `TransferChecked` whose account list carries our program (the hook is
// invoked through it), and that is how it is told apart from a transfer of
// some other mint that happened to share a transaction with us.
//
// Everything that is not in the transaction — the owner of a token account,
// the mint behind a `TokenConfig`, the rules a policy account holds — is
// asked of `Lookups`. The decoder itself does not know where the answers
// come from, so a test hands it a map and the worker hands it the RPC.
import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { IDL, PROGRAM_ID } from '@forge/chain'
import { MAX_RULE_SLOTS, RULE_KIND, RULE_SLOT_BYTES } from '@forge/policy/model'
import {
  type AttestationEvent,
  type HolderStatus,
  type HolderStatusEvent,
  type IndexedEvent,
  indexedEventSchema,
  type RefusalEvent,
  type ThawEvent,
  type TransferEvent,
} from '@forge/shared/events'
import { type RefusalCode, refusalCodeFromAnchorError } from '@forge/shared/refusal'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { InstructionView, TransactionView } from './transaction.ts'

// ─── What the decoder asks the outside for ───────────────────────────────────

/** What a `TokenConfig` says about its token, read once and kept: none of it changes. */
export interface TokenView {
  readonly mint: string
  readonly issuerId: string
  /** Seconds a reserve attestation stays current (FR-023b). */
  readonly attestationMaxAge: number
}

export interface Lookups {
  /** The `issuer_id` an `IssuerConfig` account was derived from. */
  issuerIdOfConfig(issuerConfig: string): Promise<string | undefined>
  tokenOfConfig(tokenConfig: string): Promise<TokenView | undefined>
  tokenOfMint(mint: string): Promise<TokenView | undefined>
  /** The owner wallet of a token account — for a party the balances did not name. */
  ownerOfTokenAccount(tokenAccount: string): Promise<string | undefined>
  /** The 16 rule slots of a `PolicyConfig` account, or `undefined` if it is not one. */
  policyRulesAt(policyConfig: string): Promise<Uint8Array | undefined>
  /** The `index` of a `ReserveAttestation` account. */
  attestationIndexAt(attestation: string): Promise<number | undefined>
}

// ─── What comes out ──────────────────────────────────────────────────────────

export interface MemberRow {
  readonly memberIndex: number
  readonly wallet: string
  readonly roles: number
}

/**
 * A change to the mirror tables. Each one names the on-chain fact it comes
 * from, not a table operation: the writer decides how a fact becomes rows.
 */
export type MirrorChange =
  | {
      readonly kind: 'issuer_initialized'
      readonly issuerId: string
      readonly founderWallet: string
      readonly quorumN: number
      readonly operationalKey: string
      readonly delegationMask: number
      readonly members: readonly MemberRow[]
    }
  | {
      readonly kind: 'token_created'
      readonly mint: string
      readonly issuerId: string
      readonly decimals: number
      readonly policyVersion: number
    }
  | {
      readonly kind: 'token_metadata'
      readonly mint: string
      readonly name: string
      readonly symbol: string
    }
  | { readonly kind: 'token_policy'; readonly mint: string; readonly policyVersion: number }
  | {
      readonly kind: 'holder_thawed'
      readonly mint: string
      readonly issuerId: string
      readonly wallet: string
      readonly status: HolderStatus | null
    }
  | {
      readonly kind: 'holder_status'
      readonly mint: string
      readonly issuerId: string
      readonly wallet: string
      readonly status: HolderStatus
    }

/** An event with the tenant it belongs to — the column RLS cuts the table by, not a field of the event. */
export interface EventRecord {
  readonly issuerId: string
  readonly event: IndexedEvent
}

export interface Decoded {
  readonly events: readonly EventRecord[]
  readonly changes: readonly MirrorChange[]
}

// ─── Token-2022 ──────────────────────────────────────────────────────────────

const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58()
const PROGRAM = PROGRAM_ID.toBase58()

/** `TokenInstruction::TransferChecked`: one byte of tag, u64 amount, u8 decimals. */
const TRANSFER_CHECKED_TAG = 12
const TRANSFER_CHECKED_BYTES = 10

/**
 * Where the policy account sits in a hooked transfer's account list. The
 * token program appends the hook's extra accounts after the four base ones
 * (source, mint, destination, authority) in the order of
 * `ExtraAccountMetaList`, and that list is ours: `tokenConfig` first,
 * `policyConfig` second (`hook/extra_accounts.rs`). The account fetched
 * there is still checked to be a `PolicyConfig` before its rules are read.
 */
const TRANSFER_POLICY_ACCOUNT = 4 + 1

/**
 * Token-2022's own refusals that end a transfer before the hook is called
 * (`TokenError` in `spl-token-2022-interface`, numbered by position).
 */
const TOKEN_PROGRAM_REFUSALS: ReadonlyMap<number, RefusalCode> = new Map([
  [17, 'ACCOUNT_FROZEN'],
  [67, 'TRANSFERS_PAUSED'],
])

/** A `TransferChecked` of a mint with our hook, in either position — outer or under a CPI. */
function isHookedTransfer(instruction: InstructionView): boolean {
  return (
    instruction.programId === TOKEN_2022 &&
    instruction.data.length === TRANSFER_CHECKED_BYTES &&
    instruction.data[0] === TRANSFER_CHECKED_TAG &&
    instruction.accounts.includes(PROGRAM)
  )
}

function transferAmount(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true)
}

/**
 * Which rule of the policy a refusal names, by the slot it occupies in the
 * 16-slot layout (FR-011). The hook does not log the slot — it returns the
 * code — but the code says which kind of rule fired, and a policy holds at
 * most one slot of each kind.
 */
function ruleKindOf(code: RefusalCode | null): number | null {
  switch (code) {
    case 'SENDER_STATUS_MISSING':
    case 'RECIPIENT_STATUS_MISSING':
    case 'STATUS_SOURCE_NOT_ACCEPTED':
    case 'STATUS_SOURCE_UNAVAILABLE':
    case 'SENDER_DENIED':
    case 'RECIPIENT_DENIED':
    case 'RECIPIENT_TIER_TOO_LOW':
      return RULE_KIND.STATUS
    case 'RECIPIENT_JURISDICTION_NOT_ALLOWED':
      return RULE_KIND.JURISDICTIONS
    case 'TRANSFER_LIMIT_EXCEEDED':
      return RULE_KIND.TRANSFER_LIMIT
    case 'VELOCITY_COUNTER_MISSING':
    case 'PERIOD_LIMIT_EXCEEDED':
      return RULE_KIND.PERIOD_LIMIT
    default:
      return null
  }
}

export function ruleSlotOf(rules: Uint8Array, code: RefusalCode | null): number | null {
  const kind = ruleKindOf(code)
  if (kind === null) return null
  for (let slot = 0; slot < MAX_RULE_SLOTS; slot += 1) {
    if (rules[slot * RULE_SLOT_BYTES] === kind) return slot
  }
  return null
}

// ─── Our program ─────────────────────────────────────────────────────────────

const coder = new BorshInstructionCoder(IDL)

/**
 * The account positions of each instruction, by the IDL. Named here rather
 * than read by index at the call site, so that a reorder in the program is a
 * one-line change and not a silent swap of two parties.
 */
const ACCOUNT = {
  initializeIssuer: { founder: 2 },
  createToken: { founder: 0, attestor: 1, issuerConfig: 2, mint: 3, founderTokenAccount: 7 },
  setTokenMetadata: { mint: 2 },
  setPolicy: { tokenConfig: 1 },
  thawHolder: { issuerConfig: 0, mint: 2, tokenAccount: 3, authority: 7 },
  setHolderStatus: { tokenConfig: 1, authority: 3 },
  attestReserve: { tokenConfig: 0, attestation: 1, attestor: 2 },
} as const

/** Anchor decodes a `Pubkey` to a `PublicKey`; a `u64`/`i64` to a `BN`. */
type Decodable = { toBase58(): string } | { toString(radix?: number): string }

function address(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'toBase58' in value) {
    return (value as { toBase58(): string }).toBase58()
  }
  throw new TypeError(`expected a public key, got ${typeof value}`)
}

function integer(value: unknown): bigint {
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return BigInt((value as Decodable).toString())
  }
  throw new TypeError(`expected an integer, got ${typeof value}`)
}

/** A fixed byte array (`[u8; N]`) arrives as a number array; a `Vec<u8>` as a Buffer. */
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  throw new TypeError(`expected bytes, got ${typeof value}`)
}

/** Zero-padded upper-case ASCII, as the program stores the currency and the jurisdiction. */
function ascii(value: unknown): string {
  return new TextDecoder().decode(bytes(value)).replaceAll('\0', '')
}

type StatusInput = { tier: unknown; jurisdiction: unknown; denied: unknown; expiresAt: unknown }

/** The instruction's status input, with the chain's "zero = never" turned into `null`. */
function holderStatus(input: StatusInput): HolderStatus {
  const expiresAt = Number(integer(input.expiresAt))
  return {
    tier: Number(integer(input.tier)),
    jurisdiction: ascii(input.jurisdiction),
    denied: Boolean(input.denied),
    expiresAt: expiresAt === 0 ? null : expiresAt,
  }
}

type Args = Record<string, unknown>

function argsOf(data: object): Args {
  const args = (data as { args?: unknown }).args
  if (typeof args !== 'object' || args === null) throw new TypeError('instruction has no args')
  return args as Args
}

function at(instruction: InstructionView, index: number, name: string): string {
  const account = instruction.accounts[index]
  if (account === undefined) throw new Error(`account ${name} (#${index}) is missing`)
  return account
}

// ─── The decoder ─────────────────────────────────────────────────────────────

type Envelope = Pick<IndexedEvent, 'signature' | 'slot' | 'blockTime'>

interface Context {
  readonly tx: TransactionView
  readonly lookups: Lookups
  readonly events: EventRecord[]
  readonly changes: MirrorChange[]
}

function envelopeOf(tx: TransactionView): Envelope {
  return { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime }
}

/** Something the transaction refers to that the network could not answer for. */
export class LookupFailed extends Error {
  constructor(what: string, address: string) {
    super(`${what} ${address} could not be read`)
    this.name = 'LookupFailed'
  }
}

async function transferParties(
  ctx: Context,
  instruction: InstructionView,
): Promise<Pick<TransferEvent, 'source' | 'destination' | 'sender' | 'recipient'>> {
  const source = at(instruction, 0, 'source')
  const destination = at(instruction, 2, 'destination')
  const owner = async (account: string): Promise<string> => {
    const known =
      ctx.tx.tokenOwners.get(account) ?? (await ctx.lookups.ownerOfTokenAccount(account))
    if (known === undefined) throw new LookupFailed('token account', account)
    return known
  }
  return { source, destination, sender: await owner(source), recipient: await owner(destination) }
}

async function decodeTransfer(ctx: Context, instruction: InstructionView): Promise<void> {
  const mint = at(instruction, 1, 'mint')
  const token = await ctx.lookups.tokenOfMint(mint)
  if (token === undefined) throw new LookupFailed('token', mint)

  const transfer: TransferEvent = {
    kind: 'transfer',
    ...envelopeOf(ctx.tx),
    eventIndex: ctx.events.length,
    mint,
    ...(await transferParties(ctx, instruction)),
    amount: transferAmount(instruction.data).toString(),
  }
  ctx.events.push({ issuerId: token.issuerId, event: transfer })
}

async function decodeRefusal(
  ctx: Context,
  instruction: InstructionView,
  custom: number,
): Promise<void> {
  const mint = at(instruction, 1, 'mint')
  const token = await ctx.lookups.tokenOfMint(mint)
  if (token === undefined) throw new LookupFailed('token', mint)

  const fromHook = custom >= 6000
  const code = fromHook
    ? refusalCodeFromAnchorError(custom)
    : (TOKEN_PROGRAM_REFUSALS.get(custom) ?? null)
  // A number that is neither the hook's nor a pause or a freeze is not a
  // refusal by policy: insufficient funds, a wrong decimals argument, a
  // missing signature. Those are the sender's mistakes, not the rule at work.
  if (!fromHook && code === null) return

  const policyAccount = instruction.accounts[TRANSFER_POLICY_ACCOUNT]
  const rules =
    policyAccount === undefined ? undefined : await ctx.lookups.policyRulesAt(policyAccount)

  const refusal: RefusalEvent = {
    kind: 'refusal',
    ...envelopeOf(ctx.tx),
    eventIndex: ctx.events.length,
    mint,
    ...(await transferParties(ctx, instruction)),
    amount: transferAmount(instruction.data).toString(),
    code,
    programError: custom,
    ruleSlot: rules === undefined ? null : ruleSlotOf(rules, code),
  }
  ctx.events.push({ issuerId: token.issuerId, event: refusal })
}

async function decodeInitializeIssuer(
  ctx: Context,
  instruction: InstructionView,
  args: Args,
): Promise<void> {
  const members = args.members
  if (!Array.isArray(members)) throw new TypeError('members is not a list')
  ctx.changes.push({
    kind: 'issuer_initialized',
    issuerId: address(args.issuerId),
    founderWallet: at(instruction, ACCOUNT.initializeIssuer.founder, 'founder'),
    quorumN: Number(integer(args.quorumN)),
    operationalKey: address(args.operationalKey),
    delegationMask: Number(integer(args.delegationMask)),
    // The slot in the list is the membership slot the program stores
    // (`initialize_issuer` copies the list as given), and the one the quorum
    // bitmap indexes — hence the index of the row, not a counter of its own.
    members: members.map((member: { wallet: unknown; roles: unknown }, memberIndex) => ({
      memberIndex,
      wallet: address(member.wallet),
      roles: Number(integer(member.roles)),
    })),
  })
}

async function decodeCreateToken(
  ctx: Context,
  instruction: InstructionView,
  args: Args,
): Promise<void> {
  const issuerConfig = at(instruction, ACCOUNT.createToken.issuerConfig, 'issuerConfig')
  const issuerId = await ctx.lookups.issuerIdOfConfig(issuerConfig)
  if (issuerId === undefined) throw new LookupFailed('issuer config', issuerConfig)

  const mint = at(instruction, ACCOUNT.createToken.mint, 'mint')
  const founder = at(instruction, ACCOUNT.createToken.founder, 'founder')
  const attestedAt = Number(integer(args.reserveAttestedAt))
  const maxAge = Number(integer(args.attestationMaxAge))
  const founderStatus = holderStatus(args.founderStatus as StatusInput)

  ctx.changes.push({
    kind: 'token_created',
    mint,
    issuerId,
    decimals: Number(integer(args.decimals)),
    policyVersion: 1,
  })
  // The founder's account is created, thawed and given its status in the
  // same instruction; the founder is a holder like any other from here on.
  ctx.changes.push({
    kind: 'holder_thawed',
    mint,
    issuerId,
    wallet: founder,
    status: founderStatus,
  })

  const attestation: AttestationEvent = {
    kind: 'attestation',
    ...envelopeOf(ctx.tx),
    eventIndex: ctx.events.length,
    mint,
    index: 0,
    amount: integer(args.reserveAmount).toString(),
    currency: ascii(args.reserveCurrency),
    attestor: at(instruction, ACCOUNT.createToken.attestor, 'attestor'),
    attestedAt,
    expiresAt: attestedAt + maxAge,
  }
  ctx.events.push({ issuerId, event: attestation })

  const thaw: ThawEvent = {
    kind: 'thaw',
    ...envelopeOf(ctx.tx),
    eventIndex: ctx.events.length,
    mint,
    wallet: founder,
    tokenAccount: at(instruction, ACCOUNT.createToken.founderTokenAccount, 'founderTokenAccount'),
    authority: founder,
    status: founderStatus,
  }
  ctx.events.push({ issuerId, event: thaw })
}

async function decodeSetTokenMetadata(
  ctx: Context,
  instruction: InstructionView,
  args: Args,
): Promise<void> {
  ctx.changes.push({
    kind: 'token_metadata',
    mint: at(instruction, ACCOUNT.setTokenMetadata.mint, 'mint'),
    name: String(args.name),
    symbol: String(args.symbol),
  })
}

async function decodeSetPolicy(
  ctx: Context,
  instruction: InstructionView,
  args: Args,
): Promise<void> {
  const tokenConfig = at(instruction, ACCOUNT.setPolicy.tokenConfig, 'tokenConfig')
  const token = await ctx.lookups.tokenOfConfig(tokenConfig)
  if (token === undefined) throw new LookupFailed('token config', tokenConfig)
  // No compliance event yet: the instruction carries neither a reason code
  // nor a case reference, and the event schema rightly refuses one without
  // them. T029 adds both to the arguments, and the event with them.
  ctx.changes.push({
    kind: 'token_policy',
    mint: token.mint,
    policyVersion: Number(integer(args.version)),
  })
}

async function decodeThawHolder(
  ctx: Context,
  instruction: InstructionView,
  args: Args,
): Promise<void> {
  const issuerConfig = at(instruction, ACCOUNT.thawHolder.issuerConfig, 'issuerConfig')
  const issuerId = await ctx.lookups.issuerIdOfConfig(issuerConfig)
  if (issuerId === undefined) throw new LookupFailed('issuer config', issuerConfig)

  const mint = at(instruction, ACCOUNT.thawHolder.mint, 'mint')
  const wallet = address(args.wallet)
  const status =
    args.status === null || args.status === undefined
      ? null
      : holderStatus(args.status as StatusInput)

  ctx.changes.push({ kind: 'holder_thawed', mint, issuerId, wallet, status })
  const thaw: ThawEvent = {
    kind: 'thaw',
    ...envelopeOf(ctx.tx),
    eventIndex: ctx.events.length,
    mint,
    wallet,
    tokenAccount: at(instruction, ACCOUNT.thawHolder.tokenAccount, 'tokenAccount'),
    authority: at(instruction, ACCOUNT.thawHolder.authority, 'authority'),
    status,
  }
  ctx.events.push({ issuerId, event: thaw })
}

async function decodeSetHolderStatus(
  ctx: Context,
  instruction: InstructionView,
  args: Args,
): Promise<void> {
  const tokenConfig = at(instruction, ACCOUNT.setHolderStatus.tokenConfig, 'tokenConfig')
  const token = await ctx.lookups.tokenOfConfig(tokenConfig)
  if (token === undefined) throw new LookupFailed('token config', tokenConfig)

  const wallet = address(args.wallet)
  const status = holderStatus(args.status as StatusInput)
  ctx.changes.push({
    kind: 'holder_status',
    mint: token.mint,
    issuerId: token.issuerId,
    wallet,
    status,
  })
  const event: HolderStatusEvent = {
    kind: 'holder_status',
    ...envelopeOf(ctx.tx),
    eventIndex: ctx.events.length,
    mint: token.mint,
    wallet,
    authority: at(instruction, ACCOUNT.setHolderStatus.authority, 'authority'),
    status,
  }
  ctx.events.push({ issuerId: token.issuerId, event })
}

async function decodeAttestReserve(
  ctx: Context,
  instruction: InstructionView,
  args: Args,
): Promise<void> {
  const tokenConfig = at(instruction, ACCOUNT.attestReserve.tokenConfig, 'tokenConfig')
  const token = await ctx.lookups.tokenOfConfig(tokenConfig)
  if (token === undefined) throw new LookupFailed('token config', tokenConfig)

  const attestation = at(instruction, ACCOUNT.attestReserve.attestation, 'attestation')
  const index = await ctx.lookups.attestationIndexAt(attestation)
  if (index === undefined) throw new LookupFailed('attestation', attestation)

  const attestedAt = Number(integer(args.attestedAt))
  const event: AttestationEvent = {
    kind: 'attestation',
    ...envelopeOf(ctx.tx),
    eventIndex: ctx.events.length,
    mint: token.mint,
    index,
    amount: integer(args.amount).toString(),
    currency: ascii(args.currency),
    attestor: at(instruction, ACCOUNT.attestReserve.attestor, 'attestor'),
    attestedAt,
    expiresAt: attestedAt + token.attestationMaxAge,
  }
  ctx.events.push({ issuerId: token.issuerId, event })
}

type InstructionDecoder = (ctx: Context, instruction: InstructionView, args: Args) => Promise<void>

/**
 * Instruction name (as the IDL spells it) → decoder. An instruction absent
 * here is indexed as nothing, on purpose: `initializeExtraAccountMetaList`
 * changes no state anyone sees, and `execute` is the hook's CPI, already
 * covered by the transfer that invoked it.
 */
const DECODERS: Readonly<Record<string, InstructionDecoder>> = {
  initializeIssuer: decodeInitializeIssuer,
  createToken: decodeCreateToken,
  setTokenMetadata: decodeSetTokenMetadata,
  setPolicy: decodeSetPolicy,
  thawHolder: decodeThawHolder,
  setHolderStatus: decodeSetHolderStatus,
  attestReserve: decodeAttestReserve,
}

/**
 * Everything one transaction contributes.
 *
 * A failed transaction contributes at most one thing: the refusal of the
 * hooked transfer under the instruction that failed. Nothing else in it
 * executed, so nothing else is recorded — an `initialize_issuer` that failed
 * created no issuer.
 *
 * Every event is run through the union schema before it leaves: the decoder
 * builds them by hand from bytes, and a malformed one must fail here, not in
 * the journal a regulator reads.
 */
export async function decodeTransaction(tx: TransactionView, lookups: Lookups): Promise<Decoded> {
  const ctx: Context = { tx, lookups, events: [], changes: [] }

  if (tx.failure !== null) {
    const { outerIndex, custom } = tx.failure
    const refused = tx.instructions
      .filter(
        (instruction) => instruction.outerIndex === outerIndex && isHookedTransfer(instruction),
      )
      .at(-1)
    if (refused !== undefined && custom !== null) await decodeRefusal(ctx, refused, custom)
    return finish(ctx)
  }

  for (const instruction of tx.instructions) {
    if (isHookedTransfer(instruction)) {
      await decodeTransfer(ctx, instruction)
      continue
    }
    if (instruction.programId !== PROGRAM) continue

    const decoded = coder.decode(Buffer.from(instruction.data))
    const decode = decoded === null ? undefined : DECODERS[decoded.name]
    if (decoded === null || decode === undefined) continue
    await decode(ctx, instruction, argsOf(decoded.data))
  }
  return finish(ctx)
}

function finish(ctx: Context): Decoded {
  return {
    events: ctx.events.map(({ issuerId, event }) => ({
      issuerId,
      event: indexedEventSchema.parse(event),
    })),
    changes: ctx.changes,
  }
}
