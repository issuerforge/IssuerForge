// Token issuance — three transactions, not one (FR-001, debt T018).
//
// **Why three.** `create_token` weighs ~1180 of 1232 bytes: 384 bytes of
// policy, 13 accounts, two signatures. Neither the metadata strings nor the
// hook's account list fit in there, so both go separately. Both windows are
// safe, but for different reasons, and the difference is worth knowing:
// without metadata the token is merely nameless, while without the account
// list the token program **cannot** resolve the hook — a transfer does not go
// through at all.
//
// **The addresses of all three are known before the first one**: the mint is
// a PDA (`["mint", issuer_id, index]`), so everything can be assembled at
// once. Sending is sequential: the second and the third need a `TokenConfig`,
// which does not exist until the first is confirmed.
//
// **The token number comes as an argument and is not read here.**
// `IssuerConfig` is read by whoever already has a Connection (the API route),
// and the builder stays pure. The consequence of the race is honest: if
// another issuance took the number in the meantime, the transaction fails on
// an already existing account — a visible refusal, not a twin token.
import { BN } from '@coral-xyz/anchor'
import { encodeRules } from '@forge/policy/layout'
import type { PolicyRules } from '@forge/policy/model'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import {
  extraAccountMetaListPda,
  holderStatusPda,
  issuerConfigPda,
  mintPda,
  policyConfigPda,
  reserveAttestationPda,
  tokenConfigPda,
  velocityCounterPda,
} from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

/** The number of the first policy version. `create_token` writes it; `set_policy` starts from the second. */
export const FIRST_POLICY_VERSION = 1

/** The index of the first reserve attestation. `create_token` creates it. */
export const FIRST_ATTESTATION_INDEX = 0n

/**
 * A holder status in the shape the program accepts.
 *
 * `expiresAt` of zero means "no expiry", not "expired" — the same convention
 * as in `HolderStatus` and in the rule evaluator.
 */
export type HolderStatusInput = {
  readonly tier: number
  readonly jurisdiction: string
  readonly denied: boolean
  readonly expiresAt: bigint
}

export type CreateTokenArgs = {
  readonly issuerId: PublicKey
  /**
   * `IssuerConfig.token_count` **before** issuance — the number this token
   * will take. It is also the seed of the mint address, so the address is
   * known before signing.
   */
  readonly tokenIndex: number
  readonly founder: PublicKey
  readonly attestor: PublicKey
  readonly decimals: number
  readonly attestationCredential: PublicKey
  readonly attestationSchema: PublicKey
  readonly treasury: PublicKey
  readonly feeBps: number
  readonly attestationMaxAge: bigint
  /** The reserve currency, which is also the token's currency: 3–8 upper-case letters. */
  readonly reserveCurrency: string
  readonly policy: PolicyRules
  readonly initialSupply: bigint
  readonly reserveAmount: bigint
  readonly reserveAttestedAt: bigint
  readonly founderStatus: HolderStatusInput
}

/**
 * The currency in the shape the account holds it: exactly eight bytes,
 * zero-padded. The program checks the length, but assembling a wrong array
 * here would be a refusal on devnet instead of a failure in a test.
 */
function currencyBytes(currency: string): number[] {
  const bytes = new TextEncoder().encode(currency)
  if (bytes.length === 0 || bytes.length > 8) {
    throw new RangeError(`currency must be 1 to 8 bytes: ${currency}`)
  }
  return [...bytes, ...new Array(8 - bytes.length).fill(0)]
}

/**
 * `bigint` → `BN`.
 *
 * The package boundary deliberately keeps `bigint`: it is the language's
 * native type for u64, and it is what arrives from `@forge/shared`. Anchor
 * 0.32.1 encodes through `BN` internally, so the conversion lives here — in
 * exactly one place — and `BN` does not leak into the types the console reads.
 */
const bn = (value: bigint): BN => new BN(value.toString())

function jurisdictionBytes(code: string): number[] {
  const bytes = new TextEncoder().encode(code)
  if (bytes.length !== 2) {
    throw new RangeError(`jurisdiction must be an alpha-2 code: ${code}`)
  }
  return [...bytes]
}

const toStatusInput = (status: HolderStatusInput) => ({
  tier: status.tier,
  jurisdiction: jurisdictionBytes(status.jurisdiction),
  denied: status.denied,
  expiresAt: bn(status.expiresAt),
})

/**
 * The addresses derived from an issuance. Needed by the builders and by the
 * console alike: the wizard shows the token address before signing, because
 * it is already known.
 */
export function issuanceAddresses(issuerId: PublicKey, tokenIndex: number) {
  const mint = mintPda(issuerId, tokenIndex)
  return {
    mint,
    issuerConfig: issuerConfigPda(issuerId),
    tokenConfig: tokenConfigPda(mint),
    policyConfig: policyConfigPda(mint, FIRST_POLICY_VERSION),
    attestation: reserveAttestationPda(mint, FIRST_ATTESTATION_INDEX),
    extraAccountMetaList: extraAccountMetaListPda(mint),
  }
}

/**
 * Transaction 1: the mint with its extensions, the configuration, policy
 * version 1, reserve attestation #0 and the initial issuance.
 *
 * Two signatures — the founder (who is also the payer) and the attestor. No
 * quorum: the reasoning is in `SCRATCHPAD.md`, block T018.
 */
export async function buildCreateToken(
  program: ForgeProgram,
  args: CreateTokenArgs,
): Promise<TxPlan> {
  const { mint, issuerConfig, tokenConfig, policyConfig, attestation } = issuanceAddresses(
    args.issuerId,
    args.tokenIndex,
  )

  const instruction = await program.methods
    .createToken({
      decimals: args.decimals,
      attestationCredential: args.attestationCredential,
      attestationSchema: args.attestationSchema,
      treasury: args.treasury,
      feeBps: args.feeBps,
      attestationMaxAge: bn(args.attestationMaxAge),
      reserveCurrency: currencyBytes(args.reserveCurrency),
      // The policy travels as bytes, not as a structure: the canonical encoding
      // is the only form in which it exists in the account, and it is what the
      // program hashes.
      rules: Buffer.from(encodeRules(args.policy)),
      initialSupply: bn(args.initialSupply),
      reserveAmount: bn(args.reserveAmount),
      reserveAttestedAt: bn(args.reserveAttestedAt),
      founderStatus: toStatusInput(args.founderStatus),
    })
    .accountsPartial({
      founder: args.founder,
      attestor: args.attestor,
      issuerConfig,
      mint,
      tokenConfig,
      policyConfig,
      attestation,
      founderTokenAccount: getAssociatedTokenAddressSync(
        mint,
        args.founder,
        false,
        TOKEN_2022_PROGRAM_ID,
      ),
      holderStatus: holderStatusPda(mint, args.founder),
      velocityCounter: velocityCounterPda(mint, args.founder),
      // The token program is passed explicitly even though the program accepts
      // the interface: a mint with extensions exists only in Token-2022, and a
      // mistake here would yield a token with no extension at all that would
      // look like it works.
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction()

  return toPlan('create-token', args.founder, [instruction])
}

export type SetTokenMetadataArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  readonly payer: PublicKey
  /** An admin of the issuer's membership. Not required to be the payer. */
  readonly authority: PublicKey
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

/** Transaction 2: name, symbol and URI in the mint itself. */
export async function buildSetTokenMetadata(
  program: ForgeProgram,
  args: SetTokenMetadataArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .setTokenMetadata({ name: args.name, symbol: args.symbol, uri: args.uri })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      payer: args.payer,
      authority: args.authority,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  return toPlan('token-metadata', args.payer, [instruction], true)
}

/**
 * Transaction 3: the list of accounts the token program will hand to the
 * hook.
 *
 * Without it there are no transfers at all — the resolution of the hook's
 * accounts fails on the token program's side. So it must go through before
 * the first transfer, and the wizard has no right to show the token as ready
 * until it is there.
 */
export async function buildInitializeExtraAccountMetaList(
  program: ForgeProgram,
  args: { readonly mint: PublicKey; readonly payer: PublicKey },
): Promise<TxPlan> {
  const instruction = await program.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      payer: args.payer,
      extraAccountMetaList: extraAccountMetaListPda(args.mint),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
    })
    .instruction()

  return toPlan('hook-accounts', args.payer, [instruction], true)
}

export type IssuanceArgs = CreateTokenArgs & {
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

/**
 * The whole issuance in one call: three plans in sending order.
 *
 * The order is carried by the result itself, not by an agreement between
 * callers: the second and the third plan have `dependsOnPrevious`, so the
 * wizard cannot send them as a batch and get an "account does not exist"
 * refusal.
 */
export async function buildTokenIssuance(
  program: ForgeProgram,
  args: IssuanceArgs,
): Promise<TxPlan[]> {
  const { mint } = issuanceAddresses(args.issuerId, args.tokenIndex)

  return [
    await buildCreateToken(program, args),
    await buildSetTokenMetadata(program, {
      issuerId: args.issuerId,
      mint,
      payer: args.founder,
      authority: args.founder,
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
    }),
    await buildInitializeExtraAccountMetaList(program, { mint, payer: args.founder }),
  ]
}
