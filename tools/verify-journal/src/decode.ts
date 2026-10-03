// What a transaction says happened, read by the verifier itself.
//
// This is the second reading of the chain, written apart from the indexer's
// on purpose (SC-006). If the verifier called the indexer's decoder, a
// mistake there — a swapped account, a dropped signer — would appear in the
// journal and in the verification alike, and the two would agree. So nothing
// here comes from `apps/worker`: the account positions are looked up **by
// name** in the IDL rather than numbered by hand, the node's answer is
// flattened here rather than by the worker's view, and the differential test
// (`differential.test.ts`) runs both readings over the same transactions.
//
// What is shared is only what both sides must take from one place to mean
// the same thing: the program's IDL, the refusal-code table the program
// itself checks, the rule-kind numbers and the event union of the file.
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { decodeBase58, IDL } from '@forge/chain'
import { MAX_RULE_SLOTS, RULE_KIND, RULE_SLOT_BYTES } from '@forge/policy/model'
import {
  type ComplianceAction,
  type HolderStatus,
  type IndexedEvent,
  indexedEventSchema,
} from '@forge/shared/events'
import {
  ANCHOR_ERROR_OFFSET,
  type RefusalCode,
  refusalCodeFromAnchorError,
} from '@forge/shared/refusal'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'

// ─── What the verifier asks the chain about accounts ─────────────────────────

export interface TokenFacts {
  readonly mint: string
  readonly issuerId: string
  readonly attestationMaxAge: number
}

/**
 * Account state a transaction refers to but does not carry. Every answer
 * except a token account's owner is about an account that is never rewritten
 * — a policy is a new account per version, an attestation is append-only —
 * so reading it today answers for the day of the transaction too.
 */
export interface ChainState {
  issuerIdOf(issuerConfig: string): Promise<string | undefined>
  tokenAt(tokenConfig: string): Promise<TokenFacts | undefined>
  ownerOf(tokenAccount: string): Promise<string | undefined>
  rulesAt(policyConfig: string): Promise<Uint8Array | undefined>
  attestationIndexAt(attestation: string): Promise<number | undefined>
}

/** The chain does not answer for an account the transaction names. The event is then unconfirmable, not wrong. */
export class StateUnavailable extends Error {
  constructor(what: string, address: string) {
    super(`${what} ${address} could not be read`)
    this.name = 'StateUnavailable'
  }
}

// ─── What comes out ──────────────────────────────────────────────────────────

/**
 * An instruction of the program that executed but that the journal format
 * does not carry. Reported, never counted as missing: the file is not
 * expected to hold it, and silence about it would look like "nothing else
 * happened".
 */
export interface UnjournalledInstruction {
  readonly signature: string
  readonly slot: number
  readonly instruction: string
  readonly why: string
  readonly accounts: readonly string[]
}

export interface ChainReading {
  /** Every event of the transaction, of every mint — `eventIndex` counts across all of them. */
  readonly events: readonly IndexedEvent[]
  readonly unjournalled: readonly UnjournalledInstruction[]
}

// ─── The node's answer, flattened ────────────────────────────────────────────

interface Instruction {
  readonly programId: string
  readonly accounts: readonly string[]
  readonly data: Uint8Array
  readonly outer: number
}

interface Transaction {
  readonly signature: string
  readonly slot: number
  readonly blockTime: number | null
  /** Outer instructions, each followed by what it invoked: execution order. */
  readonly instructions: readonly Instruction[]
  /** The failing outer instruction and its custom error number, if the transaction failed. */
  readonly failed: { readonly outer: number; readonly custom: number | null } | null
  /** Token account → owner, as the node recorded the balances. */
  readonly owners: ReadonlyMap<string, string>
}

function flatten(signature: string, response: VersionedTransactionResponse): Transaction {
  const { message } = response.transaction
  const loaded = response.meta?.loadedAddresses
  // Instructions index the static keys and then the looked-up ones, writable first.
  const keys = [
    ...message.staticAccountKeys.map((key) => key.toBase58()),
    ...(loaded?.writable ?? []).map((key) => key.toBase58()),
    ...(loaded?.readonly ?? []).map((key) => key.toBase58()),
  ]
  const key = (index: number): string => {
    const found = keys[index]
    if (found === undefined) throw new Error(`account index ${index} is not in the message`)
    return found
  }

  const inner = new Map<number, Instruction[]>()
  for (const group of response.meta?.innerInstructions ?? []) {
    inner.set(
      group.index,
      group.instructions.map((ix) => ({
        programId: key(ix.programIdIndex),
        accounts: ix.accounts.map(key),
        data: decodeBase58(ix.data),
        outer: group.index,
      })),
    )
  }
  const instructions = message.compiledInstructions.flatMap((ix, outer) => [
    {
      programId: key(ix.programIdIndex),
      accounts: ix.accountKeyIndexes.map(key),
      data: Uint8Array.from(ix.data),
      outer,
    },
    ...(inner.get(outer) ?? []),
  ])

  const owners = new Map<string, string>()
  for (const balance of [
    ...(response.meta?.preTokenBalances ?? []),
    ...(response.meta?.postTokenBalances ?? []),
  ]) {
    if (balance.owner !== undefined) owners.set(key(balance.accountIndex), balance.owner)
  }

  return {
    signature,
    slot: response.slot,
    blockTime: response.blockTime ?? null,
    instructions,
    failed: failureOf(response.meta?.err),
    owners,
  }
}

function failureOf(err: unknown): Transaction['failed'] {
  if (err === null || err === undefined) return null
  const instructionError =
    typeof err === 'object' ? (err as { InstructionError?: unknown }).InstructionError : undefined
  if (!Array.isArray(instructionError) || typeof instructionError[0] !== 'number') {
    // Failed before any instruction ran (fees, blockhash): nothing executed, nothing refused.
    return { outer: -1, custom: null }
  }
  const detail: unknown = instructionError[1]
  const custom =
    typeof detail === 'object' && detail !== null
      ? (detail as { Custom?: unknown }).Custom
      : undefined
  return { outer: instructionError[0], custom: typeof custom === 'number' ? custom : null }
}

// ─── The program, by its IDL ─────────────────────────────────────────────────

const idl = IDL as unknown as Idl
const coder = new BorshInstructionCoder(idl)
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58()

/** Account names of each instruction, in the order the program declares them. */
const ACCOUNT_NAMES: ReadonlyMap<string, readonly string[]> = new Map(
  idl.instructions.map((ix) => [ix.name, ix.accounts.map((account) => account.name)]),
)

class Accounts {
  readonly #names: readonly string[]
  readonly #instruction: Instruction
  readonly #name: string

  constructor(name: string, instruction: Instruction) {
    const names = ACCOUNT_NAMES.get(name)
    if (names === undefined) throw new Error(`the IDL has no instruction ${name}`)
    this.#names = names
    this.#instruction = instruction
    this.#name = name
  }

  /** The account the IDL names `account`. */
  get(account: string): string {
    const index = this.#names.indexOf(account)
    const found = index < 0 ? undefined : this.#instruction.accounts[index]
    if (found === undefined) throw new Error(`${this.#name}: no account ${account}`)
    return found
  }

  /**
   * The accounts after the declared list — where the program takes the
   * quorum's approvers from (`remaining_accounts`), on both paths.
   */
  remaining(): string[] {
    return this.#instruction.accounts.slice(this.#names.length)
  }
}

// ─── Reading arguments ───────────────────────────────────────────────────────

type Args = Record<string, unknown>

function pubkey(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58()
  throw new TypeError('expected a public key')
}

function int(value: unknown): bigint {
  if (typeof value === 'number' || typeof value === 'bigint') return BigInt(value)
  if (typeof value === 'object' && value !== null) return BigInt(String(value))
  throw new TypeError('expected an integer')
}

/** Fixed-width, zero-padded ASCII: a currency, a jurisdiction, a case reference. */
function text(value: unknown): string {
  const bytes =
    value instanceof Uint8Array
      ? value
      : Array.isArray(value)
        ? Uint8Array.from(value as number[])
        : undefined
  if (bytes === undefined) throw new TypeError('expected bytes')
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end -= 1
  return new TextDecoder().decode(bytes.subarray(0, end))
}

function status(value: unknown): HolderStatus {
  const input = value as Args
  const expiresAt = Number(int(input.expiresAt))
  return {
    tier: Number(int(input.tier)),
    jurisdiction: text(input.jurisdiction),
    denied: input.denied === true,
    // On chain zero means "never"; in the journal it is null, not the epoch.
    expiresAt: expiresAt === 0 ? null : expiresAt,
  }
}

function reason(args: Args): { reasonCode: string; caseRef: string } {
  const input = args.reason as Args
  return { reasonCode: int(input.code).toString(), caseRef: text(input.caseRef) }
}

// ─── Instructions → events ───────────────────────────────────────────────────

type Draft = IndexedEvent extends infer E
  ? E extends IndexedEvent
    ? Omit<E, 'signature' | 'slot' | 'blockTime' | 'eventIndex'>
    : never
  : never

interface Reader {
  readonly tx: Transaction
  readonly state: ChainState
}

type EventReader = (reader: Reader, accounts: Accounts, args: Args) => Promise<Draft[]>

async function issuerOf(state: ChainState, issuerConfig: string): Promise<string> {
  const issuerId = await state.issuerIdOf(issuerConfig)
  if (issuerId === undefined) throw new StateUnavailable('issuer config', issuerConfig)
  return issuerId
}

async function tokenAt(state: ChainState, tokenConfig: string): Promise<TokenFacts> {
  const token = await state.tokenAt(tokenConfig)
  if (token === undefined) throw new StateUnavailable('token config', tokenConfig)
  return token
}

/** An action by a quorum: the approvers follow the declared accounts, and only they are named. */
function byQuorum(action: ComplianceAction, withTarget: boolean): EventReader {
  return async ({ state }, accounts, args) => {
    const mint = accounts.get('mint')
    await issuerOf(state, accounts.get('issuerConfig'))
    return [
      {
        kind: 'compliance',
        mint,
        action,
        target: withTarget ? accounts.get('source') : null,
        amount: withTarget ? int(args.amount).toString() : null,
        ...reason(args),
        signers: accounts.remaining(),
      },
    ]
  }
}

/** An officer's own action on one account: the officer is the one signer (FR-014). */
function byOfficer(action: 'freeze' | 'unfreeze'): EventReader {
  return async ({ state }, accounts, args) => {
    await issuerOf(state, accounts.get('issuerConfig'))
    return [
      {
        kind: 'compliance',
        mint: accounts.get('mint'),
        action,
        target: accounts.get('tokenAccount'),
        amount: null,
        ...reason(args),
        signers: [accounts.get('officer')],
      },
    ]
  }
}

const EVENT_READERS: Readonly<Record<string, EventReader>> = {
  async createToken({ state }, accounts, args) {
    await issuerOf(state, accounts.get('issuerConfig'))
    const mint = accounts.get('mint')
    const founder = accounts.get('founder')
    const attestedAt = Number(int(args.reserveAttestedAt))
    const founderStatus = status(args.founderStatus)
    return [
      {
        kind: 'attestation',
        mint,
        index: 0,
        amount: int(args.reserveAmount).toString(),
        currency: text(args.reserveCurrency),
        attestor: accounts.get('attestor'),
        attestedAt,
        expiresAt: attestedAt + Number(int(args.attestationMaxAge)),
      },
      {
        kind: 'thaw',
        mint,
        wallet: founder,
        tokenAccount: accounts.get('founderTokenAccount'),
        authority: founder,
        status: founderStatus,
      },
    ]
  },

  async setPolicy({ state }, accounts, args) {
    const token = await tokenAt(state, accounts.get('tokenConfig'))
    return [
      {
        kind: 'compliance',
        mint: token.mint,
        action: 'set_policy',
        target: null,
        amount: null,
        ...reason(args),
        signers: accounts.remaining(),
      },
    ]
  },

  async thawHolder({ state }, accounts, args) {
    await issuerOf(state, accounts.get('issuerConfig'))
    return [
      {
        kind: 'thaw',
        mint: accounts.get('mint'),
        wallet: pubkey(args.wallet),
        tokenAccount: accounts.get('tokenAccount'),
        authority: accounts.get('authority'),
        status: args.status === null || args.status === undefined ? null : status(args.status),
      },
    ]
  },

  async setHolderStatus({ state }, accounts, args) {
    const token = await tokenAt(state, accounts.get('tokenConfig'))
    return [
      {
        kind: 'holder_status',
        mint: token.mint,
        wallet: pubkey(args.wallet),
        authority: accounts.get('authority'),
        status: status(args.status),
      },
    ]
  },

  freezeHolder: byOfficer('freeze'),
  unfreezeHolder: byOfficer('unfreeze'),
  seize: byQuorum('seize', true),
  pauseCirculation: byQuorum('pause', false),
  resumeCirculation: byQuorum('unpause', false),

  async attestReserve({ state }, accounts, args) {
    const token = await tokenAt(state, accounts.get('tokenConfig'))
    const attestation = accounts.get('attestation')
    const index = await state.attestationIndexAt(attestation)
    if (index === undefined) throw new StateUnavailable('attestation', attestation)
    const attestedAt = Number(int(args.attestedAt))
    return [
      {
        kind: 'attestation',
        mint: token.mint,
        index,
        amount: int(args.amount).toString(),
        currency: text(args.currency),
        attestor: accounts.get('attestor'),
        attestedAt,
        expiresAt: attestedAt + token.attestationMaxAge,
      },
    ]
  },
}

/**
 * Instructions that executed and change something, but that format v1 has
 * no line for. The reasons are the ones the file's readers would ask about.
 */
const UNJOURNALLED: Readonly<Record<string, string>> = {
  initializeIssuer: 'issuer setup — the journal is per token',
  setTokenMetadata: 'name and symbol, not an action',
  initializeExtraAccountMetaList: 'hook wiring, not an action',
  setDelegation: 'operational-key delegation — issuer-level, not in format v1',
  proposeAction: 'proposal lifecycle — not in format v1',
  approveAction: 'proposal lifecycle — not in format v1',
  closeActionProposal: 'proposal lifecycle — not in format v1',
}

/** The hook's own entry point: the transfer that invoked it is the event. */
const PART_OF_A_TRANSFER = new Set(['execute'])

// ─── Transfers ───────────────────────────────────────────────────────────────

/** `TransferChecked`: tag 12, u64 amount, u8 decimals. */
function isHookedTransfer(ix: Instruction, programId: string): boolean {
  return (
    ix.programId === TOKEN_2022 &&
    ix.data.length === 10 &&
    ix.data[0] === 12 &&
    // The token program passes the hook program among the extra accounts;
    // a transfer of a mint without our hook does not name it.
    ix.accounts.includes(programId)
  )
}

/** Token-2022 refuses these itself, before our hook runs: `AccountFrozen`, `NonTransferable…Paused`. */
const TOKEN_PROGRAM_REFUSAL: ReadonlyMap<number, RefusalCode> = new Map([
  [17, 'ACCOUNT_FROZEN'],
  [67, 'TRANSFERS_PAUSED'],
])

/** Which rule kind answers for a refusal code; codes outside any rule have none. */
const RULE_OF: Partial<Record<RefusalCode, number>> = {
  SENDER_STATUS_MISSING: RULE_KIND.STATUS,
  RECIPIENT_STATUS_MISSING: RULE_KIND.STATUS,
  STATUS_SOURCE_NOT_ACCEPTED: RULE_KIND.STATUS,
  STATUS_SOURCE_UNAVAILABLE: RULE_KIND.STATUS,
  SENDER_DENIED: RULE_KIND.STATUS,
  RECIPIENT_DENIED: RULE_KIND.STATUS,
  RECIPIENT_TIER_TOO_LOW: RULE_KIND.STATUS,
  RECIPIENT_JURISDICTION_NOT_ALLOWED: RULE_KIND.JURISDICTIONS,
  TRANSFER_LIMIT_EXCEEDED: RULE_KIND.TRANSFER_LIMIT,
  VELOCITY_COUNTER_MISSING: RULE_KIND.PERIOD_LIMIT,
  PERIOD_LIMIT_EXCEEDED: RULE_KIND.PERIOD_LIMIT,
}

/** The slot of the policy the rule kind sits in — a policy holds each kind at most once. */
function slotOfKind(rules: Uint8Array, kind: number | undefined): number | null {
  if (kind === undefined) return null
  for (let slot = 0; slot < MAX_RULE_SLOTS; slot += 1) {
    if (rules[slot * RULE_SLOT_BYTES] === kind) return slot
  }
  return null
}

async function transferDraft(
  { tx, state }: Reader,
  ix: Instruction,
): Promise<{
  mint: string
  source: string
  destination: string
  sender: string
  recipient: string
  amount: string
}> {
  const [source, mint, destination] = ix.accounts
  if (source === undefined || mint === undefined || destination === undefined) {
    throw new Error('a transfer without its accounts')
  }
  const owner = async (account: string): Promise<string> => {
    const known = tx.owners.get(account) ?? (await state.ownerOf(account))
    if (known === undefined) throw new StateUnavailable('token account', account)
    return known
  }
  const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
  return {
    mint,
    source,
    destination,
    sender: await owner(source),
    recipient: await owner(destination),
    amount: view.getBigUint64(1, true).toString(),
  }
}

/**
 * The policy account in a hooked `TransferChecked`: the token program appends
 * the hook's extra accounts after the four base ones in the order of the
 * program's `ExtraAccountMetaList` — `tokenConfig`, then `policyConfig`.
 */
const POLICY_POSITION_IN_TRANSFER = 5

async function refusalDraft(reader: Reader, ix: Instruction, custom: number): Promise<Draft[]> {
  const fromHook = custom >= ANCHOR_ERROR_OFFSET
  const code = fromHook ? refusalCodeFromAnchorError(custom) : TOKEN_PROGRAM_REFUSAL.get(custom)
  // Anything else — insufficient funds, wrong decimals — is the sender's
  // mistake, not a rule refusing.
  if (code === undefined) return []

  const parties = await transferDraft(reader, ix)
  const policy = ix.accounts[POLICY_POSITION_IN_TRANSFER]
  const rules = policy === undefined ? undefined : await reader.state.rulesAt(policy)
  return [
    {
      kind: 'refusal',
      ...parties,
      code,
      programError: custom,
      ruleSlot: rules === undefined || code === null ? null : slotOfKind(rules, RULE_OF[code]),
    },
  ]
}

// ─── One transaction ─────────────────────────────────────────────────────────

export async function readTransaction(
  signature: string,
  response: VersionedTransactionResponse,
  programId: string,
  state: ChainState,
): Promise<ChainReading> {
  const tx = flatten(signature, response)
  const reader: Reader = { tx, state }
  const drafts: Draft[] = []
  const unjournalled: UnjournalledInstruction[] = []

  if (tx.failed !== null) {
    // Nothing in a failed transaction executed. The one thing it leaves in
    // the journal is the refusal of the hooked transfer that failed it.
    const { outer, custom } = tx.failed
    const refused = tx.instructions
      .filter((ix) => ix.outer === outer && isHookedTransfer(ix, programId))
      .at(-1)
    if (refused !== undefined && custom !== null) {
      drafts.push(...(await refusalDraft(reader, refused, custom)))
    }
  } else {
    for (const ix of tx.instructions) {
      if (isHookedTransfer(ix, programId)) {
        drafts.push({ kind: 'transfer', ...(await transferDraft(reader, ix)) })
        continue
      }
      if (ix.programId !== programId) continue

      const decoded = coder.decode(Buffer.from(ix.data))
      if (decoded === null) throw new Error('an instruction of the program the IDL cannot read')
      if (PART_OF_A_TRANSFER.has(decoded.name)) continue

      const read = EVENT_READERS[decoded.name]
      if (read !== undefined) {
        const args = (decoded.data as { args?: Args }).args ?? {}
        drafts.push(...(await read(reader, new Accounts(decoded.name, ix), args)))
        continue
      }
      unjournalled.push({
        signature,
        slot: tx.slot,
        instruction: decoded.name,
        why: UNJOURNALLED[decoded.name] ?? 'an instruction this verifier does not know',
        accounts: ix.accounts,
      })
    }
  }

  const events = drafts.map((draft, eventIndex) =>
    indexedEventSchema.parse({
      ...draft,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      eventIndex,
    }),
  )
  return { events, unjournalled }
}
