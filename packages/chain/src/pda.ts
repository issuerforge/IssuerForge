import { U64_MAX } from '@forge/shared/primitives'
import { getExtraAccountMetaAddress } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { IDL } from './idl/issuer-forge.ts'

/**
 * The program address. The only source is the vendored IDL: it comes from the
 * same build as `declare_id!`, so it cannot diverge from the program. For now
 * it is the placeholder `ForgePo1icy1111…`; the real address arrives by
 * regenerating the IDL after the first deploy, not by editing a constant.
 */
export const PROGRAM_ID = new PublicKey(IDL.address)

const utf8 = new TextEncoder()

/**
 * Seed labels. Must match `programs/issuer-forge/src/constants.rs` — today
 * only `issuer` and `token` exist there, the rest arrive with their
 * instructions (`docs/PLAN.md` → "Data model").
 */
export const SEED = {
  issuer: utf8.encode('issuer'),
  mint: utf8.encode('mint'),
  token: utf8.encode('token'),
  policy: utf8.encode('policy'),
  holder: utf8.encode('holder'),
  velocity: utf8.encode('velocity'),
  proposal: utf8.encode('proposal'),
  reserve: utf8.encode('reserve'),
  redemption: utf8.encode('redemption'),
} as const

/**
 * A numeric seed is **little-endian**, exactly as wide as the type the field
 * is declared with in Rust.
 *
 * This is not style: `to_le_bytes()` is what Anchor gets in `seeds = [...]`,
 * and a divergence here breaks neither the build nor the types. It simply
 * derives a different address, and that shows up as a `ConstraintSeeds`
 * refusal on devnet. The tests in `pda.test.ts` pin the bytes themselves, not
 * just the address.
 */
export function u32Seed(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff_ff_ff) {
    throw new RangeError(`seed does not fit in u32: ${value}`)
  }
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

/** The same for `u64`. Counters and nonces do not fit in a double, hence `bigint`. */
export function u64Seed(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`seed does not fit in u64: ${value}`)
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

function derive(seeds: Uint8Array[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

/**
 * `IssuerConfig` — `["issuer", issuer_id]`.
 *
 * `issuer_id` is not the founder's wallet and signs nothing: otherwise that
 * wallet would remain a load-bearing part forever, even after the quorum
 * removed it for being compromised (`constants.rs`).
 */
export function issuerConfigPda(issuerId: PublicKey, programId = PROGRAM_ID): PublicKey {
  return derive([SEED.issuer, issuerId.toBytes()], programId)
}

/**
 * The token itself — `["mint", issuer_id, index]`, index `u32`.
 *
 * The mint is a PDA, not a client key: a third signature in the issuance
 * transaction does not fit into its 1232 bytes (`SCRATCHPAD.md`, block T018).
 * For the client this is better than a compromise — the token address is
 * known before signing, and the list of an issuer's tokens is built by walking
 * the numbers from zero, with no indexer.
 *
 * `index` is `IssuerConfig.token_count` **before** issuance, i.e. the number
 * the instruction will take.
 */
export function mintPda(issuerId: PublicKey, index: number, programId = PROGRAM_ID): PublicKey {
  return derive([SEED.mint, issuerId.toBytes(), u32Seed(index)], programId)
}

/** `TokenConfig` — `["token", mint]`. */
export function tokenConfigPda(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return derive([SEED.token, mint.toBytes()], programId)
}

/**
 * `PolicyConfig` — `["policy", mint, version]`, version `u32`.
 *
 * The version in the seeds is the immutability of history (FR-010): a new
 * policy does not overwrite the account, it creates the next one, and the hook
 * reads exactly the version the mint is configured with.
 */
export function policyConfigPda(
  mint: PublicKey,
  version: number,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.policy, mint.toBytes(), u32Seed(version)], programId)
}

/**
 * `HolderStatus` — `["holder", mint, wallet]`.
 *
 * `wallet` is the owner of the token account, not the token account itself:
 * the hook reads it as a slice of the account data (offset 32) and must arrive
 * at the same address as the client.
 */
export function holderStatusPda(
  mint: PublicKey,
  wallet: PublicKey,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.holder, mint.toBytes(), wallet.toBytes()], programId)
}

/** `VelocityCounter` — `["velocity", mint, wallet]`. The same `wallet`. */
export function velocityCounterPda(
  mint: PublicKey,
  wallet: PublicKey,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.velocity, mint.toBytes(), wallet.toBytes()], programId)
}

/** `ActionProposal` — `["proposal", mint, nonce]`, nonce `u64`. */
export function actionProposalPda(
  mint: PublicKey,
  nonce: bigint,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.proposal, mint.toBytes(), u64Seed(nonce)], programId)
}

/**
 * `ReserveAttestation` — `["reserve", mint, index]`, index `u64`.
 *
 * An index, not a time: the account is append-only, and it is the sequential
 * number that makes "the previous attestation" addressable rather than found
 * by search.
 */
export function reserveAttestationPda(
  mint: PublicKey,
  index: bigint,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.reserve, mint.toBytes(), u64Seed(index)], programId)
}

/**
 * `RedemptionEscrow` — `["redemption", mint, request_id]`.
 *
 * `request_id` is 32 client-generated bytes, not a counter: two requests
 * submitted at the same time must not compete for the next number. The same
 * reason as for `issuer_id`.
 */
export function redemptionEscrowPda(
  mint: PublicKey,
  requestId: PublicKey,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.redemption, mint.toBytes(), requestId.toBytes()], programId)
}

/**
 * `ExtraAccountMetaList` — `["extra-account-metas", mint]` under the hook
 * program.
 *
 * Not derived by hand: the seeds are set by `spl-tlv-account-resolution`, and
 * repeating them here would mean keeping a copy of someone else's constant.
 * The token program looks the account up by its own formula — a divergence
 * from it makes a transfer impossible altogether.
 */
export function extraAccountMetaListPda(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return getExtraAccountMetaAddress(mint, programId)
}
