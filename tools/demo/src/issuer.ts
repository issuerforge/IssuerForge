// Емітент: склад, кворум і межі, у яких діє операційний ключ платформи.
//
// Це єдина дія, що не проходить кворум, — бо до неї кворуму ще немає (T007).
// Далі все, що вона задає, змінюється тільки кворумом.
import { issuerConfigPda } from '@forge/chain'
import { DELEGATION, ROLE } from '@forge/shared/api'
import type { PublicKey } from '@solana/web3.js'
import { SystemProgram } from '@solana/web3.js'
import type { DemoContext } from './context.ts'
import type { Sent } from './send.ts'
import { submit } from './send.ts'

export interface IssuerSetup {
  readonly issuerId: PublicKey
  readonly issuerConfig: PublicKey
  readonly sent: Sent
}

/**
 * Склад демо — рівно той, який потрібен, щоб пройти шлях US1.
 *
 * Атестатор окремим гаманцем: FR-024 забороняє йому будь-які інші
 * повноваження, тож поєднати його з засновником не можна навіть у демо — і
 * саме на цьому тримається другий підпис у транзакції випуску.
 */
export async function createIssuer(context: DemoContext): Promise<IssuerSetup> {
  const { keys, connection, program } = context
  const issuerId = keys.issuerId.publicKey

  const instruction = await program.methods
    .initializeIssuer({
      issuerId,
      members: [
        { wallet: keys.founder.publicKey, roles: ROLE.ADMIN },
        { wallet: keys.officer.publicKey, roles: ROLE.COMPLIANCE },
        { wallet: keys.attestor.publicKey, roles: ROLE.ATTESTOR },
      ],
      // Двоє: адміністратор і офіцер. Атестатор до кворуму не входить, тож
      // порогу вище за 2 у цьому складі немає, а нижче програма не приймає.
      quorumN: 2,
      operationalKey: keys.operational.publicKey,
      // Обидва повноваження, які потрібні US1: розморозити рахунок і змінити
      // статус. Емісії й вилучення в масці немає й бути не може (FR-035a).
      delegationMask: DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS,
    })
    .accountsPartial({
      issuerConfig: issuerConfigPda(issuerId),
      payer: keys.founder.publicKey,
      founder: keys.founder.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const sent = await submit(connection, keys.founder.publicKey, [instruction], [keys.founder])

  return { issuerId, issuerConfig: issuerConfigPda(issuerId), sent }
}
