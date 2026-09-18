// Attempts to violate the rule — the SC-002 measurement.
//
// **Success here is a refusal.** Every case below is built so that it would
// pass if the rule lived in the app; that it does not pass is the project's
// claim: the token itself enforces the rule (FR-002).
//
// Four vectors, and none of them is a variation of another:
//   1. **a third-party client** — a transfer assembled bypassing our
//      builders, straight with `spl-token`;
//   2. **CPI** — a call from a foreign program on chain
//      (`programs/attacker`);
//   3. **a delegate** — `approve` and a transfer by someone else's hands;
//   4. **splitting** — every amount under the per-transfer limit, together
//      over the per-period limit.
import { buildTransfer } from '@forge/chain'
import { refusalCodeFromAnchorError } from '@forge/shared/refusal'
import {
  createApproveInstruction,
  createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { type Keypair, type PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { DemoContext } from './context.ts'
import { ataOf } from './holders.ts'
import { expectRefusal, PassedThrough, type Refused } from './send.ts'

export interface Attempt {
  readonly vector: 'third-party' | 'cpi' | 'delegate' | 'splitting'
  readonly name: string
  readonly refused: boolean
  readonly code: number | undefined
  /** Our refusal code, if the number belongs to the hook. */
  readonly refusalCode: string | null
  /**
   * Who refused, when the code is not ours.
   *
   * A token program refusal ("account frozen", "missing account") is a
   * requirement enforced too, but a **different** one: FR-008b holds two
   * gates, and a report that merges them into "unknown" does not show which
   * of them fired.
   */
  readonly refusedBy: string | undefined
}

export interface AttackReport {
  readonly attempts: readonly Attempt[]
  readonly total: number
  readonly refused: number
  readonly byVector: Record<string, { total: number; refused: number }>
}

/**
 * The last log line in which the network said why it refused.
 *
 * We take `Program … failed: …` — it is what names the program, not the
 * consequence.
 */
const refusedBy = (refusal: Refused | undefined): string | undefined => {
  const failure = [...(refusal?.logs ?? [])].reverse().find((line) => line.includes(' failed: '))
  if (failure !== undefined) return failure.split(' failed: ')[1]
  return refusal === undefined ? undefined : refusal.message.split(String.fromCharCode(10))[0]
}

const record = (
  vector: Attempt['vector'],
  name: string,
  refusal: Refused | undefined,
): Attempt => ({
  vector,
  name,
  refused: refusal !== undefined,
  code: refusal?.code,
  refusalCode: refusal?.code === undefined ? null : refusalCodeFromAnchorError(refusal.code),
  refusedBy: refusal?.code === undefined ? refusedBy(refusal) : undefined,
})

/**
 * An attempt expected to be refused; `undefined` means it **went through**.
 *
 * Exactly `PassedThrough` is caught. Everything else is a broken measurement
 * (an account does not resolve, an instruction does not assemble), and it
 * must stop the run rather than land in the report as "the rule did not
 * fire".
 */
async function attempt(run: () => Promise<Refused>): Promise<Refused | undefined> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof PassedThrough) return undefined
    throw error
  }
}

export interface AttackInput {
  readonly mint: PublicKey
  readonly decimals: number
  /** A wallet that holds the token and has a current status. */
  readonly holder: Keypair
  /** The one the issuer never let in: neither an ATA nor a status. */
  readonly stranger: Keypair
  /** An admitted holder in an allowed jurisdiction. */
  readonly allowed: PublicKey
  /** The per-transfer limit in the smallest unit. */
  readonly transferLimit: bigint
  /** How many times to repeat each case: the 50 attempts are reached by repetition. */
  readonly repeats: number
  /** The address of the relay program. */
  readonly attackerProgram: PublicKey
}

/**
 * A transfer assembled by builders that are **not ours**.
 *
 * This is exactly what bypassing the app looks like: the client takes
 * `spl-token` and composes `transfer_checked` itself. It adds no extra hook
 * accounts — and cannot know they are needed unless it read
 * `ExtraAccountMetaList`.
 */
function rawTransfer(
  mint: PublicKey,
  owner: PublicKey,
  recipient: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  return createTransferCheckedInstruction(
    ataOf(mint, owner),
    mint,
    ataOf(mint, recipient),
    owner,
    amount,
    decimals,
    [],
    TOKEN_2022_PROGRAM_ID,
  )
}

export async function runAttacks(context: DemoContext, input: AttackInput): Promise<AttackReport> {
  const { connection, keys } = context
  const attempts: Attempt[] = []

  for (let round = 0; round < input.repeats; round += 1) {
    const amount = 1_000n + BigInt(round)

    // ── 1. A third-party client ────────────────────────────────────────────
    attempts.push(
      record(
        'third-party',
        'raw transfer_checked without the hook accounts',
        await attempt(() =>
          expectRefusal(
            connection,
            input.holder.publicKey,
            [
              rawTransfer(
                input.mint,
                input.holder.publicKey,
                input.allowed,
                amount,
                input.decimals,
              ),
            ],
            [input.holder],
          ),
        ),
      ),
    )

    attempts.push(
      record(
        'third-party',
        'transfer to an account this issuer never let in',
        await attempt(async () =>
          expectRefusal(
            connection,
            input.holder.publicKey,
            (
              await buildTransfer(connection, {
                mint: input.mint,
                owner: input.holder.publicKey,
                recipient: input.stranger.publicKey,
                amount,
                decimals: input.decimals,
              })
            ).instructions,
            [input.holder],
          ),
        ),
      ),
    )

    attempts.push(
      record(
        'third-party',
        'transfer one unit over the per-transfer limit',
        await attempt(async () =>
          expectRefusal(
            connection,
            input.holder.publicKey,
            (
              await buildTransfer(connection, {
                mint: input.mint,
                owner: input.holder.publicKey,
                recipient: input.allowed,
                amount: input.transferLimit + 1n,
                decimals: input.decimals,
              })
            ).instructions,
            [input.holder],
          ),
        ),
      ),
    )

    // ── 2. CPI from a foreign program ──────────────────────────────────────
    attempts.push(
      record(
        'cpi',
        'relayed through another on-chain program',
        await attempt(async () =>
          expectRefusal(
            connection,
            input.holder.publicKey,
            [await relayInstruction(context, input, input.stranger.publicKey, amount)],
            [input.holder],
          ),
        ),
      ),
    )

    attempts.push(
      record(
        'cpi',
        'relayed over the limit through another program',
        await attempt(async () =>
          expectRefusal(
            connection,
            input.holder.publicKey,
            [await relayInstruction(context, input, input.allowed, input.transferLimit + 1n)],
            [input.holder],
          ),
        ),
      ),
    )

    // ── 3. A delegate ──────────────────────────────────────────────────────
    attempts.push(
      record(
        'delegate',
        'approved delegate moves to an account never let in',
        await attempt(async () => {
          const approve = createApproveInstruction(
            ataOf(input.mint, input.holder.publicKey),
            keys.operational.publicKey,
            input.holder.publicKey,
            amount * 10n,
            [],
            TOKEN_2022_PROGRAM_ID,
          )
          const transfer = await buildTransfer(connection, {
            mint: input.mint,
            owner: input.holder.publicKey,
            recipient: input.stranger.publicKey,
            amount,
            decimals: input.decimals,
          })
          // The delegate signs instead of the owner: the source account is the
          // same, the authority is someone else's. The policy reads the
          // **owner**, which is exactly why delegation opens nothing.
          const delegated = transfer.instructions.map((instruction) =>
            withAuthority(instruction, input.holder.publicKey, keys.operational.publicKey),
          )
          return await expectRefusal(
            connection,
            keys.operational.publicKey,
            [approve, ...delegated],
            [input.holder, keys.operational],
          )
        }),
      ),
    )
  }

  // ── 4. Splitting ─────────────────────────────────────────────────────────
  // Every amount is under the per-transfer limit; together they outgrow the
  // per-period limit, and the refusal comes on the transfer that crossed it.
  const slice = input.transferLimit
  for (let index = 0; index < input.repeats * 2; index += 1) {
    const refusal = await attempt(async () =>
      expectRefusal(
        connection,
        input.holder.publicKey,
        (
          await buildTransfer(connection, {
            mint: input.mint,
            owner: input.holder.publicKey,
            recipient: input.allowed,
            amount: slice,
            decimals: input.decimals,
          })
        ).instructions,
        [input.holder],
      ),
    )
    // The first few transfers are legitimate: the per-period limit is not yet
    // exhausted. Only those that should violate it — i.e. after the crossing
    // — go into the report.
    if (refusal !== undefined) {
      attempts.push(record('splitting', `slice ${index + 1} over the period limit`, refusal))
    }
  }

  const byVector: Record<string, { total: number; refused: number }> = {}
  for (const item of attempts) {
    const bucket = byVector[item.vector] ?? { total: 0, refused: 0 }
    bucket.total += 1
    if (item.refused) bucket.refused += 1
    byVector[item.vector] = bucket
  }

  return {
    attempts,
    total: attempts.length,
    refused: attempts.filter((item) => item.refused).length,
    byVector,
  }
}

/**
 * The foreign program's instruction: the same accounts as a direct transfer,
 * plus the hook accounts in the tail.
 *
 * The tail is mandatory: the token program hands the hook exactly what
 * arrived, and without it the refusal would be "missing account", not "the
 * rule does not allow".
 */
async function relayInstruction(
  context: DemoContext,
  input: AttackInput,
  recipient: PublicKey,
  amount: bigint,
): Promise<TransactionInstruction> {
  const direct = await buildTransfer(context.connection, {
    mint: input.mint,
    owner: input.holder.publicKey,
    recipient,
    amount,
    decimals: input.decimals,
  })

  const inner = direct.instructions[0]
  if (inner === undefined) throw new Error('the transfer builder produced no instruction')

  // The first four accounts are the source, the mint, the destination and
  // the owner; then the token program (our instruction takes it as a separate
  // account), and the tail is everything the hook resolved.
  const [source, mint, destination, authority, ...rest] = inner.keys

  if (
    source === undefined ||
    mint === undefined ||
    destination === undefined ||
    authority === undefined
  ) {
    throw new Error('the transfer instruction has fewer accounts than a transfer needs')
  }

  return new TransactionInstruction({
    programId: input.attackerProgram,
    keys: [
      { ...source, isSigner: false },
      mint,
      destination,
      { ...authority, isSigner: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ...rest,
    ],
    data: relayData(amount, input.decimals),
  })
}

/**
 * The body of the `relay_transfer` instruction: the Anchor discriminator
 * plus two arguments.
 *
 * The discriminator is computed as `sha256("global:relay_transfer")[0..8]` —
 * the same thing Anchor does. There is deliberately no client for the attack
 * program here: it exists for exactly one call, and generating an IDL client
 * for it would mean a second on-chain client in the repository for the sake
 * of eight bytes.
 */
function relayData(amount: bigint, decimals: number): Buffer {
  const discriminator = Buffer.from([0x21, 0x6b, 0x97, 0xb4, 0xb0, 0xbb, 0xa2, 0xb6])
  const body = Buffer.alloc(9)
  body.writeBigUInt64LE(amount, 0)
  body.writeUInt8(decimals, 8)
  return Buffer.concat([discriminator, body])
}

/** The same transfer, but a different address authorises it. */
function withAuthority(
  instruction: TransactionInstruction,
  owner: PublicKey,
  delegate: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: instruction.programId,
    data: instruction.data,
    keys: instruction.keys.map((key) =>
      key.pubkey.equals(owner) && key.isSigner
        ? { pubkey: delegate, isSigner: true, isWritable: key.isWritable }
        : key,
    ),
  })
}
