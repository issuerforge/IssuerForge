// The issuer: the membership, the quorum and the bounds within which the
// platform's operational key acts.
//
// This is the only action that does not go through the quorum — because
// before it there is no quorum yet (T007). From then on everything it sets is
// changed only by quorum.
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
 * The demo membership — exactly what is needed to walk the US1 path.
 *
 * The attestor is a separate wallet: FR-024 forbids them any other powers,
 * so they cannot be merged with the founder even in a demo — and that is
 * what the second signature in the issuance transaction rests on.
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
      // Two: the admin and the officer. The attestor is not part of the
      // quorum, so there is no threshold above 2 in this membership, and the
      // program does not accept one below.
      quorumN: 2,
      operationalKey: keys.operational.publicKey,
      // Both powers US1 needs: thaw an account and change a status. Issuance
      // and seizure are not in the mask and cannot be (FR-035a).
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
