// Issuance above the attested reserve — the SC-005 measurement (partial, as
// M1 carries it).
//
// **One check for every way tokens come into existence** (T055): both the
// initial issuance in `create_token` and the future `mint` go through the
// same inequality. On M1 only the first path exists, so it is what is
// measured: ten attempts to issue more than is attested, and none may pass.
import { buildTokenIssuance } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import type { PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext } from './context.ts'
import { expectRefusal, PassedThrough, type Refused } from './send.ts'

export interface ReserveReport {
  readonly attempts: number
  readonly refused: number
  readonly codes: readonly (string | undefined)[]
}

/**
 * Every attempt takes **the same** token number — the next free one.
 *
 * The temptation to give each its own number leads to a false measurement:
 * `create_token` derives the mint seeds from `issuer_config.token_count`, not
 * from an argument, so a second attempt with number `2` fails on
 * `ConstraintSeeds` — i.e. on an address mismatch, not on the reserve. That
 * is how the first run gave nine "refusals" of the wrong nature. No attempt
 * passes, the counter does not move, and the number stays free.
 */
export async function attemptOverReserve(
  context: DemoContext,
  issuerId: PublicKey,
  policy: PolicyRules,
  attempts: number,
  nextIndex: number,
): Promise<ReserveReport> {
  const { connection, program, keys } = context
  const codes: (string | undefined)[] = []
  let refused = 0

  for (let index = 0; index < attempts; index += 1) {
    const now = await chainTime(connection)
    const reserveAmount = 1_000_000n
    // Above the reserve by exactly one: the line is visible next to it rather
    // than two unrelated numbers (the same rule as in the scenario catalogue,
    // T021).
    const initialSupply = reserveAmount + 1n

    const plans = await buildTokenIssuance(program, {
      issuerId,
      tokenIndex: nextIndex,
      founder: keys.founder.publicKey,
      attestor: keys.attestor.publicKey,
      decimals: 2,
      attestationCredential: keys.issuerId.publicKey,
      attestationSchema: keys.treasury.publicKey,
      treasury: keys.treasury.publicKey,
      feeBps: 0,
      attestationMaxAge: BigInt(24 * 3600),
      reserveCurrency: 'NGN',
      policy,
      initialSupply,
      reserveAmount,
      reserveAttestedAt: BigInt(now),
      founderStatus: { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: 0n },
      name: `Over Reserve ${index}`,
      symbol: `OVR${index}`,
      uri: 'https://vantara.example/over.json',
    })

    const first = plans[0]
    if (first === undefined) throw new Error('the issuance builder produced no transaction')

    let refusal: Refused | undefined
    try {
      refusal = await expectRefusal(connection, keys.founder.publicKey, first.instructions, [
        keys.founder,
        keys.attestor,
      ])
    } catch (error) {
      if (!(error instanceof PassedThrough)) throw error
    }

    if (refusal !== undefined) refused += 1
    codes.push(refusal?.name)
  }

  return { attempts, refused, codes }
}
