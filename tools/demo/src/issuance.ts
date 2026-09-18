// Token issuance: three transactions, as the wizard assembles them.
//
// **Goes exactly the same way as the console** — the same T020 builders, in
// the same order and with the same dependency: the second and the third
// transactions read a `TokenConfig` that does not exist until the first is
// confirmed.
//
// The time from the first signature to the confirmation of the third is
// SC-001.
import { buildTokenIssuance, issuanceAddresses } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import type { PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext } from './context.ts'
import type { Sent } from './send.ts'
import { submitPlan } from './send.ts'

export interface IssuanceInput {
  readonly issuerId: PublicKey
  readonly tokenIndex: number
  readonly decimals: number
  readonly policy: PolicyRules
  readonly initialSupply: bigint
  readonly reserveAmount: bigint
  readonly reserveCurrency: string
  readonly feeBps: number
  readonly attestationMaxAge: bigint
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

export interface IssuanceResult {
  readonly addresses: ReturnType<typeof issuanceAddresses>
  readonly steps: readonly Sent[]
  /** Milliseconds from the first send to the confirmation of the third (SC-001). */
  readonly elapsedMs: number
}

export async function issueToken(
  context: DemoContext,
  input: IssuanceInput,
): Promise<IssuanceResult> {
  const { connection, program, keys } = context
  const now = await chainTime(connection)

  const plans = await buildTokenIssuance(program, {
    issuerId: input.issuerId,
    tokenIndex: input.tokenIndex,
    founder: keys.founder.publicKey,
    attestor: keys.attestor.publicKey,
    decimals: input.decimals,
    // The provider's attestation credential and schema: in the demo they are
    // fixtures, because there is no attestation service on the local
    // validator, and the M1 policy reads the issuer's own registry. The
    // addresses must still be real keys — the program stores them and the
    // hook derives an account from them.
    attestationCredential: keys.issuerId.publicKey,
    attestationSchema: keys.treasury.publicKey,
    treasury: keys.treasury.publicKey,
    feeBps: input.feeBps,
    attestationMaxAge: input.attestationMaxAge,
    reserveCurrency: input.reserveCurrency,
    policy: input.policy,
    initialSupply: input.initialSupply,
    reserveAmount: input.reserveAmount,
    reserveAttestedAt: BigInt(now),
    // The founder receives the whole initial issuance, so their status must
    // satisfy their own policy — otherwise the token goes nowhere.
    founderStatus: {
      tier: 2,
      jurisdiction: 'NG',
      denied: false,
      expiresAt: 0n,
    },
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
  })

  const startedAt = Date.now()
  const steps: Sent[] = []

  for (const plan of plans) {
    // Sequentially and with waiting: `dependsOnPrevious` in the plan is not a
    // remark but a ban on sending as a batch.
    steps.push(
      await submitPlan(
        connection,
        plan,
        // The signers are derived from the instructions (T020); the keys are
        // picked by address, not by a guess about the order.
        [keys.founder, keys.attestor].filter((keypair) =>
          plan.signers.some((signer) => signer.equals(keypair.publicKey)),
        ),
      ),
    )
  }

  return {
    addresses: issuanceAddresses(input.issuerId, input.tokenIndex),
    steps,
    elapsedMs: Date.now() - startedAt,
  }
}
