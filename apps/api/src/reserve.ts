// A token's reserve as the chain holds it: the terms in `TokenConfig` and the
// latest `ReserveAttestation` (FR-021, FR-023a, FR-025).
//
// **The chain, not a mirror.** These are the numbers a holder or a regulator
// reads on the public page, and SC-007 asks for them to match the chain. The
// history of attestations is the indexer's (T042); the latest is read here.
//
// The same shape as `chain.ts` and `compliance.ts`: an interface plus a
// factory from a ready connection, so the routes are tested with no node.
import { type ForgeProgram, reserveAttestationPda, tokenConfigPda } from '@forge/chain'
import type { PublicKey } from '@solana/web3.js'

export interface AttestationView {
  readonly index: bigint
  readonly amount: bigint
  readonly currency: string
  readonly attestor: string
  readonly attestedAt: number
}

export interface ReserveTerms {
  /** The `IssuerConfig` address the token belongs to. */
  readonly issuerConfig: string
  /** The attestor in force — the only key `attest_reserve` accepts. */
  readonly attestor: string
  readonly attestationMaxAge: number
  /** The index the next attestation is written at. */
  readonly attestationCount: bigint
  readonly currency: string
  /** Declared and read publicly before any issuance (FR-038a). */
  readonly feeBps: number
  /**
   * `null` only if the record at `count - 1` is missing, which `create_token`
   * makes impossible — but a read does not invent a reserve it did not find.
   */
  readonly latest: AttestationView | null
}

export interface ReserveReader {
  /** `undefined` — no `TokenConfig` at this mint. */
  terms(mint: PublicKey): Promise<ReserveTerms | undefined>
}

export interface ReserveStanding {
  /** The mint's supply: what the program's gate counts, seized funds included. */
  readonly circulation: bigint
  readonly reserve: bigint
  /** `reserve − circulation`; negative after a smaller attestation, and shown as such. */
  readonly difference: bigint
  readonly attestation: {
    readonly index: bigint
    readonly attestor: string
    readonly attestedAt: number
    readonly expiresAt: number
    readonly ageSeconds: number
  } | null
  /** As `ReserveCheck` decides it: past the token's **current** period. */
  readonly expired: boolean
  /** The latest attestation's attestor is no longer the token's; `require_latest` refuses it. */
  readonly attestorReplaced: boolean
}

/**
 * The page's verdicts, computed the way the program computes them, so that
 * "expired" here and a refused issuance there never disagree by a second.
 * Expiry and a short reserve stay separate fields (FR-023a): each is a
 * different thing for the issuer to do.
 */
export function reserveStanding(
  terms: ReserveTerms,
  circulation: bigint,
  now: number,
): ReserveStanding {
  const latest = terms.latest
  const reserve = latest?.amount ?? 0n
  return {
    circulation,
    reserve,
    difference: reserve - circulation,
    attestation:
      latest === null
        ? null
        : {
            index: latest.index,
            attestor: latest.attestor,
            attestedAt: latest.attestedAt,
            expiresAt: latest.attestedAt + terms.attestationMaxAge,
            // A server clock behind the attestor's is not an attestation from
            // the future — the program has already accepted it against its own.
            ageSeconds: Math.max(0, now - latest.attestedAt),
          },
    expired: latest === null || now - latest.attestedAt > terms.attestationMaxAge,
    attestorReplaced: latest !== null && latest.attestor !== terms.attestor,
  }
}

/** Zero-padded ASCII, as the program stores the currency. */
export function decodeCurrency(bytes: readonly number[]): string {
  const end = bytes.indexOf(0)
  return Buffer.from(end === -1 ? bytes : bytes.slice(0, end)).toString('ascii')
}

export function createReserveReader(program: ForgeProgram): ReserveReader {
  return {
    async terms(mint) {
      const config = await program.account.tokenConfig.fetchNullable(tokenConfigPda(mint))
      if (config === null) return undefined

      const count = BigInt(config.attestationCount.toString())
      const record =
        count === 0n
          ? null
          : await program.account.reserveAttestation.fetchNullable(
              reserveAttestationPda(mint, count - 1n),
            )

      return {
        issuerConfig: config.issuer.toBase58(),
        attestor: config.attestor.toBase58(),
        attestationMaxAge: config.attestationMaxAge.toNumber(),
        attestationCount: count,
        currency: decodeCurrency(config.reserveCurrency),
        feeBps: config.feeBps,
        latest:
          record === null
            ? null
            : {
                index: BigInt(record.index.toString()),
                amount: BigInt(record.amount.toString()),
                currency: decodeCurrency(record.currency),
                attestor: record.attestor.toBase58(),
                attestedAt: record.attestedAt.toNumber(),
              },
      }
    },
  }
}
