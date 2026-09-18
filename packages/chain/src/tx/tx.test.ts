import { encodeRules } from '@forge/policy/layout'
import { OPEN_POLICY } from '@forge/policy/model'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { extraAccountMetaListPda, mintPda, tokenConfigPda } from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { buildSetHolderStatus, buildThawHolder } from './holders.ts'
import {
  buildCreateToken,
  buildInitializeExtraAccountMetaList,
  buildSetTokenMetadata,
  buildTokenIssuance,
  type CreateTokenArgs,
  type IssuanceArgs,
  issuanceAddresses,
} from './issue.ts'
import {
  compileTransaction,
  fromBase64,
  MAX_TRANSACTION_BYTES,
  type TxPlan,
  transactionBytes,
} from './plan.ts'

// The node address is not used here: no issuance builder goes to the network,
// and `Program` needs a provider only for sending, which the package does not
// do.
const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const FOUNDER = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const ATTESTOR = new PublicKey('SysvarRent111111111111111111111111111111111')
const TREASURY = new PublicKey('SysvarRecentB1ockHashes11111111111111111111')
const CREDENTIAL = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const SCHEMA = new PublicKey('SysvarS1otHistory11111111111111111111111111')

/**
 * The plan's only instruction.
 *
 * Not a convenience: every T020 plan consists of exactly one instruction, and
 * a second one added some day would change the transaction size silently. So
 * the check sits here rather than being repeated in every test.
 */
function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

/** The account address at a position. The position matters: the program sets it, not us. */
function keyAt(plan: TxPlan, index: number): PublicKey {
  const key = only(plan).keys[index]
  if (key === undefined) throw new RangeError(`${plan.step}: no account at ${index}`)
  return key.pubkey
}

/** Someone else's blockhash — compilation does not depend on it, and the size only on its length. */
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'

const createArgs = (over: Partial<CreateTokenArgs> = {}): CreateTokenArgs => ({
  issuerId: ISSUER_ID,
  tokenIndex: 0,
  founder: FOUNDER,
  attestor: ATTESTOR,
  decimals: 2,
  attestationCredential: CREDENTIAL,
  attestationSchema: SCHEMA,
  treasury: TREASURY,
  feeBps: 25,
  attestationMaxAge: 604_800n,
  reserveCurrency: 'NGN',
  policy: OPEN_POLICY,
  initialSupply: 1_000_000n,
  reserveAmount: 1_000_000n,
  reserveAttestedAt: 1_800_000_000n,
  founderStatus: { tier: 3, jurisdiction: 'NG', denied: false, expiresAt: 0n },
  ...over,
})

const issuanceArgs = (over: Partial<IssuanceArgs> = {}): IssuanceArgs => ({
  ...createArgs(),
  name: 'Naira Stable',
  symbol: 'NGNS',
  uri: 'https://issuerforge.example/token/ngns.json',
  ...over,
})

describe('token issuance', () => {
  it('is made of the same accounts the program declares', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const { mint, issuerConfig, tokenConfig, policyConfig, attestation } = issuanceAddresses(
      ISSUER_ID,
      0,
    )

    const keys = only(plan).keys.map((key) => key.pubkey.toBase58())
    // Thirteen accounts is the number the transaction budget was computed for
    // (SCRATCHPAD.md, block T018). A fourteenth will not fit silently.
    expect(keys).toHaveLength(13)
    expect(keys.slice(0, 7)).toEqual(
      [FOUNDER, ATTESTOR, issuerConfig, mint, tokenConfig, policyConfig, attestation].map((key) =>
        key.toBase58(),
      ),
    )
    // Token-2022 is passed explicitly: a mint with extensions does not exist in
    // the old token program, and a token without extensions would look like it
    // works.
    expect(keys).toContain(TOKEN_2022_PROGRAM_ID.toBase58())
  })

  it('there are two signers, and they are derived from the instruction', async () => {
    const plan = await buildCreateToken(program, createArgs())
    expect(plan.signers.map((key) => key.toBase58())).toEqual([
      FOUNDER.toBase58(),
      ATTESTOR.toBase58(),
    ])
    expect(plan.feePayer.toBase58()).toBe(FOUNDER.toBase58())
  })

  /**
   * The most important test in the package. The transaction budget is the
   * tightest constraint in the project: T018 computed ~1180 of 1232 **on
   * paper**, and here the number is finally measured rather than estimated.
   * The shortest policy is taken (`OPEN_POLICY`), but it still takes all 384
   * bytes: a fixed-length array of slots.
   */
  it('fits in a transaction — the same budget T018 computed', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const size = transactionBytes(compileTransaction(plan, BLOCKHASH))

    expect(size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)
    // The headroom is named as a number on purpose: if it disappears, that
    // must be visible in the test's diff, not in a failed transaction on
    // devnet.
    expect(MAX_TRANSACTION_BYTES - size).toBeGreaterThan(20)
  })

  it('the transaction is versioned, with an empty address-table list', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const transaction = compileTransaction(plan, BLOCKHASH)

    expect(transaction.version).toBe(0)
    expect(transaction.message.addressTableLookups).toEqual([])
  })

  /**
   * The two signatures on `create_token` are put on by different wallets, so
   * the transaction travels between them as a string. The round trip must
   * yield the same bytes: a signature is over specific bytes, and a
   * transaction assembled a second time would be a different one.
   */
  it('survives a round trip through the transport form unchanged', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const transaction = compileTransaction(plan, BLOCKHASH)
    const base64 = Buffer.from(transaction.serialize()).toString('base64')

    expect(Buffer.from(fromBase64(base64).serialize())).toEqual(
      Buffer.from(transaction.serialize()),
    )
  })

  it('the policy travels as canonical bytes, not as a structure', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const data = only(plan).data
    const encoded = Buffer.from(encodeRules(OPEN_POLICY))

    expect(encoded).toHaveLength(384)
    expect(data.includes(encoded)).toBe(true)
  })

  it('the token number is part of the mint address, so two issuances never coincide', async () => {
    const first = await buildCreateToken(program, createArgs({ tokenIndex: 0 }))
    const second = await buildCreateToken(program, createArgs({ tokenIndex: 1 }))

    expect(keyAt(first, 3).equals(mintPda(ISSUER_ID, 0))).toBe(true)
    expect(keyAt(second, 3).equals(mintPda(ISSUER_ID, 1))).toBe(true)
  })
})

describe('an issuance is three transactions', () => {
  it('they come in send order, and the order is carried by the result itself', async () => {
    const plans = await buildTokenIssuance(program, issuanceArgs())

    expect(plans.map((plan) => plan.step)).toEqual([
      'create-token',
      'token-metadata',
      'hook-accounts',
    ])
    // The second and the third read a `TokenConfig` that does not exist until
    // the first is confirmed. The flag is here so the wizard cannot send them
    // as a batch.
    expect(plans.map((plan) => plan.dependsOnPrevious)).toEqual([false, true, true])
  })

  it('all three address the same token, known before the first of them', async () => {
    const plans = await buildTokenIssuance(program, issuanceArgs())
    const mint = mintPda(ISSUER_ID, 0)

    const [create, metadata, hook] = plans
    const holds = (plan: TxPlan | undefined, address: PublicKey): boolean =>
      plan !== undefined && only(plan).keys.some((key) => key.pubkey.equals(address))

    expect(holds(create, mint)).toBe(true)
    expect(holds(metadata, tokenConfigPda(mint))).toBe(true)
    expect(holds(hook, extraAccountMetaListPda(mint))).toBe(true)
  })

  it('metadata and the hook account list are signed by the founder alone', async () => {
    const [, metadata, hook] = await buildTokenIssuance(program, issuanceArgs())
    expect(metadata?.signers).toHaveLength(1)
    expect(hook?.signers).toHaveLength(1)
  })

  it('each of the three fits in a transaction', async () => {
    const plans = await buildTokenIssuance(program, issuanceArgs())
    for (const plan of plans) {
      expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
        MAX_TRANSACTION_BYTES,
      )
    }
  })

  it('the longest allowed metadata fits too', async () => {
    // The ceilings are set by the program (32/12/200); the transaction must hold all of them.
    const plan = await buildSetTokenMetadata(program, {
      issuerId: ISSUER_ID,
      mint: mintPda(ISSUER_ID, 0),
      payer: FOUNDER,
      authority: ATTESTOR,
      name: 'x'.repeat(32),
      symbol: 'y'.repeat(12),
      uri: `https://${'z'.repeat(180)}.example`,
    })

    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
    // The payer and the one who authorises are different signatures: there is
    // room for that here, unlike in `create_token`.
    expect(plan.signers).toHaveLength(2)
  })

  it('the hook account list is addressed under the hook program', async () => {
    const mint = mintPda(ISSUER_ID, 0)
    const plan = await buildInitializeExtraAccountMetaList(program, { mint, payer: FOUNDER })
    expect(keyAt(plan, 1).equals(extraAccountMetaListPda(mint))).toBe(true)
  })
})

describe('holder onboarding', () => {
  const mint = mintPda(ISSUER_ID, 0)

  it('a thaw is signed by the payer and the one who authorises', async () => {
    const plan = await buildThawHolder(program, {
      issuerId: ISSUER_ID,
      mint,
      wallet: TREASURY,
      payer: FOUNDER,
      authority: ATTESTOR,
      status: { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: 0n },
    })

    expect(plan.step).toBe('thaw-holder')
    expect(plan.signers.map((key) => key.toBase58())).toEqual([
      FOUNDER.toBase58(),
      ATTESTOR.toBase58(),
    ])
  })

  it('a repeated thaw goes without a status', async () => {
    const plan = await buildThawHolder(program, {
      issuerId: ISSUER_ID,
      mint,
      wallet: TREASURY,
      payer: FOUNDER,
      authority: ATTESTOR,
      // `null` — "the record already exists, I am not touching it". The program
      // rejects a mismatch between the intent and the account state, so the
      // shape matters here.
      status: null,
    })

    expect(plan.instructions).toHaveLength(1)
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })

  it('a status change does not touch the token account — freezing is a separate action', async () => {
    const plan = await buildSetHolderStatus(program, {
      issuerId: ISSUER_ID,
      mint,
      wallet: TREASURY,
      authority: ATTESTOR,
      status: { tier: 1, jurisdiction: 'KE', denied: true, expiresAt: 0n },
    })

    expect(only(plan).keys).toHaveLength(4)
    expect(plan.signers.map((key) => key.toBase58())).toEqual([ATTESTOR.toBase58()])
  })

  it('a jurisdiction of the wrong size is rejected at assembly, not on chain', async () => {
    await expect(
      buildSetHolderStatus(program, {
        issuerId: ISSUER_ID,
        mint,
        wallet: TREASURY,
        authority: ATTESTOR,
        status: { tier: 1, jurisdiction: 'NGA', denied: false, expiresAt: 0n },
      }),
    ).rejects.toThrow(RangeError)
  })
})

describe('reserve currency', () => {
  it('is padded with zeros to eight bytes', async () => {
    const plan = await buildCreateToken(program, createArgs({ reserveCurrency: 'NGN' }))
    expect(only(plan).data.includes(Buffer.from([0x4e, 0x47, 0x4e, 0, 0, 0, 0, 0]))).toBe(true)
  })

  it('longer than eight bytes is rejected at assembly', async () => {
    await expect(
      buildCreateToken(program, createArgs({ reserveCurrency: 'TOOLONGXX' })),
    ).rejects.toThrow(RangeError)
  })
})
