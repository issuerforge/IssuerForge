// Спроби порушити правило — вимір SC-002.
//
// **Успіх тут — це відмова.** Кожен випадок нижче будується так, щоб пройти,
// якби правило жило в застосунку; те, що він не проходить, і є твердженням
// проєкту: правило виконує сам токен (FR-002).
//
// Чотири вектори, і жоден із них не є варіацією одного:
//   1. **сторонній клієнт** — переказ зібраний повз наші білдери, напряму
//      `spl-token`;
//   2. **CPI** — виклик із чужої програми на ланцюгу (`programs/attacker`);
//   3. **делегат** — `approve` й переказ чужими руками;
//   4. **дроблення** — кожна сума під лімітом на переказ, разом понад ліміт за
//      період.
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
  /** Наш код відмови, якщо номер належить хуку. */
  readonly refusalCode: string | null
  /**
   * Хто відмовив, коли код не наш.
   *
   * Відмова токен-програми («рахунок заморожений», «бракує акаунта») — це теж
   * виконана вимога, але вимога **інша**: FR-008b тримає два гейти, і звіт, у
   * якому вони злиті в «unknown», не показує, який із них спрацював.
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
 * Останній рядок лога, у якому мережа сказала, чому відмовила.
 *
 * Беремо `Program … failed: …` — саме він називає програму, а не наслідок.
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
 * Спроба, від якої чекають відмови; `undefined` означає, що вона **пройшла**.
 *
 * Ловиться рівно `PassedThrough`. Усе інше — зламаний вимір (не резолвиться
 * акаунт, не збирається інструкція), і воно мусить зупинити прогін, а не
 * лягти в звіт рядком «правило не спрацювало».
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
  /** Гаманець, який тримає токен і має чинний статус. */
  readonly holder: Keypair
  /** Той, кого емітент не впускав: ані ATA, ані статусу. */
  readonly stranger: Keypair
  /** Впущений холдер у дозволеній юрисдикції. */
  readonly allowed: PublicKey
  /** Ліміт на один переказ у найменших одиницях. */
  readonly transferLimit: bigint
  /** Скільки разів повторити кожен випадок: 50 спроб набираються повторами. */
  readonly repeats: number
  /** Адреса програми-посередника. */
  readonly attackerProgram: PublicKey
}

/**
 * Переказ, зібраний **не нашими** білдерами.
 *
 * Саме так виглядає обхід застосунку: клієнт бере `spl-token` і складає
 * `transfer_checked` сам. Додаткових акаунтів хука він не додає — і не може
 * знати, що вони потрібні, якщо не читав `ExtraAccountMetaList`.
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

    // ── 1. Сторонній клієнт ────────────────────────────────────────────────
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

    // ── 2. CPI з чужої програми ────────────────────────────────────────────
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

    // ── 3. Делегат ─────────────────────────────────────────────────────────
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
          // Делегат підписує замість власника: акаунт джерела той самий, а
          // повноваження — чужі. Політика читає **власника**, і саме тому
          // делегування нічого не відкриває.
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

  // ── 4. Дроблення ─────────────────────────────────────────────────────────
  // Кожна сума під лімітом на переказ; разом вони переростають ліміт за період,
  // і відмова приходить на тому переказі, який його перетнув.
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
    // Перші кілька переказів законні: ліміт за період ще не вичерпаний. У звіт
    // потрапляють лише ті, що мали б порушити його, — тобто після перетину.
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
 * Інструкція чужої програми: ті самі акаунти, що й у прямого переказу, плюс
 * акаунти хука в хвості.
 *
 * Хвіст обов'язковий: токен-програма підкладає хуку рівно те, що прийшло, і
 * без нього відмова була б «бракує акаунта», а не «правило не дозволяє».
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

  // Перші чотири акаунти — джерело, mint, отримувач, власник; далі йде
  // токен-програма (її наша інструкція приймає окремим акаунтом), а хвіст —
  // усе, що резолвив хук.
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
 * Тіло інструкції `relay_transfer`: дискримінатор Anchor плюс два аргументи.
 *
 * Дискримінатор рахується як `sha256("global:relay_transfer")[0..8]` — те саме
 * робить Anchor. Клієнта програми-атаки тут немає навмисно: вона існує рівно
 * для одного виклику, і генерувати під неї IDL-клієнт означало б завести в
 * репозиторії другий ончейн-клієнт заради восьми байтів.
 */
function relayData(amount: bigint, decimals: number): Buffer {
  const discriminator = Buffer.from([0x21, 0x6b, 0x97, 0xb4, 0xb0, 0xbb, 0xa2, 0xb6])
  const body = Buffer.alloc(9)
  body.writeBigUInt64LE(amount, 0)
  body.writeUInt8(decimals, 8)
  return Buffer.concat([discriminator, body])
}

/** Той самий переказ, але санкціонує його інша адреса. */
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
