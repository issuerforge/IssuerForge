// What the officer's screen reads from the chain: the issuer's tokens, the
// officer's freezes, the seizure vault and the pause (FR-014, FR-016, FR-020).
//
// **The chain, not the mirror — for the same reason as `actions.ts`.** These
// numbers are what a regulator is told: "this much is frozen, this much was
// seized". A mirror one confirmation behind would report a freeze that was
// already lifted, and FR-020 asks for totals, not for a recent impression of
// them.
//
// **A freeze is a `FreezeRecord`, not a frozen token account.** Token-2022
// says `Frozen` both for an account that was never onboarded and for one an
// officer froze (T026). Only the record tells them apart, so the totals sum the
// records' accounts and leave the onboarding queue out: a holder who has not
// been admitted yet was never "frozen by the issuer".
//
// The same shape as `chain.ts`: an interface plus a factory from a ready
// connection, so the routes are tested with no node.
import {
  type ComplianceReasonInput,
  type ForgeProgram,
  freezeRecordPda,
  fromReason,
  issuerConfigPda,
  mintPda,
  seizureVaultAddress,
  tokenConfigPda,
} from '@forge/chain'
import {
  ExtensionType,
  getExtensionData,
  getPausableConfig,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'
import type { Connection, PublicKey } from '@solana/web3.js'

/** A mint as the officer sees it. */
export interface MintView {
  readonly mint: string
  readonly decimals: number
  readonly supply: bigint
  /** The mint's own `Pausable` flag — what transfers obey, not `TokenConfig.paused_at`. */
  readonly paused: boolean
  /** `null` when the metadata transaction (T018) has not landed yet. */
  readonly name: string | null
  readonly symbol: string | null
}

export interface TokenListing extends MintView {
  /** The `index` in `["mint", issuer_id, index]` — the order of issuance. */
  readonly index: number
  readonly policyVersion: number
  /** `TokenConfig.paused_at`, or `null` for zero. The moment, not the state. */
  readonly pausedAt: number | null
}

export interface FreezeView {
  readonly mint: string
  readonly tokenAccount: string
  /** The owner at the moment of the freeze, from the record. */
  readonly wallet: string
  readonly officer: string
  /** Who gets the rent back when the freeze is lifted — the program pins it. */
  readonly payer: string
  readonly reason: ComplianceReasonInput
  readonly frozenAt: number
  /** Lifting returns the account here: thawed, or back to the onboarding queue. */
  readonly wasThawed: boolean
  /** The balance now. `0n` when the account is gone — closed accounts hold nothing. */
  readonly amount: bigint
}

export interface TokenAccountView {
  readonly address: string
  readonly mint: string
  readonly owner: string
  readonly amount: bigint
  readonly frozen: boolean
}

export interface ComplianceReader {
  /** `undefined` — the issuer has no `IssuerConfig` on chain. */
  tokens(issuerId: PublicKey): Promise<TokenListing[] | undefined>
  /** `undefined` — no Token-2022 mint at this address. */
  mint(mint: PublicKey): Promise<MintView | undefined>
  /** Every officer's freeze on this mint's accounts, newest first. */
  freezes(mint: PublicKey): Promise<FreezeView[]>
  freeze(tokenAccount: PublicKey): Promise<FreezeView | undefined>
  /** `undefined` — not a Token-2022 account. */
  tokenAccount(address: PublicKey): Promise<TokenAccountView | undefined>
  /** The seizure vault's balance; zero before the first seizure creates it. */
  seized(mint: PublicKey): Promise<{ readonly vault: string; readonly amount: bigint }>
}

/**
 * Name and symbol out of the `TokenMetadata` extension.
 *
 * Read by hand rather than through `@solana/spl-token-metadata`: the two
 * strings sit right after two addresses, each behind a `u32` length, and a
 * dependency (with its own `@solana/*` tree) for eight lines would be a poor
 * trade against the pins in `CLAUDE.md`.
 */
export function readNameAndSymbol(data: Buffer | null): { name: string; symbol: string } | null {
  if (data === null) return null
  let offset = 64 // update authority, mint
  const next = (): string | null => {
    if (offset + 4 > data.length) return null
    const length = data.readUInt32LE(offset)
    offset += 4
    if (offset + length > data.length) return null
    const value = data.subarray(offset, offset + length).toString('utf8')
    offset += length
    return value
  }
  const name = next()
  const symbol = next()
  return name === null || symbol === null ? null : { name, symbol }
}

type RawFreeze = {
  mint: PublicKey
  tokenAccount: PublicKey
  wallet: PublicKey
  officer: PublicKey
  payer: PublicKey
  reason: { code: number; caseRef: number[] }
  frozenAt: { toNumber(): number }
  wasThawed: boolean
}

export function createComplianceReader(
  connection: Connection,
  program: ForgeProgram,
): ComplianceReader {
  const toMintView = (address: PublicKey, info: Parameters<typeof unpackMint>[1]) => {
    const mint = unpackMint(address, info, TOKEN_2022_PROGRAM_ID)
    const meta = readNameAndSymbol(getExtensionData(ExtensionType.TokenMetadata, mint.tlvData))
    return {
      mint: address.toBase58(),
      decimals: mint.decimals,
      supply: mint.supply,
      paused: getPausableConfig(mint)?.paused === true,
      name: meta?.name ?? null,
      symbol: meta?.symbol ?? null,
    } satisfies MintView
  }

  const balances = async (accounts: readonly PublicKey[]): Promise<bigint[]> => {
    if (accounts.length === 0) return []
    const infos = await connection.getMultipleAccountsInfo([...accounts])
    return infos.map((info, index) => {
      const key = accounts[index]
      if (info === null || key === undefined) return 0n
      return unpackAccount(key, info, TOKEN_2022_PROGRAM_ID).amount
    })
  }

  const toFreeze = (raw: RawFreeze, amount: bigint): FreezeView => ({
    mint: raw.mint.toBase58(),
    tokenAccount: raw.tokenAccount.toBase58(),
    wallet: raw.wallet.toBase58(),
    officer: raw.officer.toBase58(),
    payer: raw.payer.toBase58(),
    reason: fromReason(raw.reason),
    frozenAt: raw.frozenAt.toNumber(),
    wasThawed: raw.wasThawed,
    amount,
  })

  return {
    async tokens(issuerId) {
      const config = await program.account.issuerConfig.fetchNullable(issuerConfigPda(issuerId))
      if (config === null) return undefined

      const mints = Array.from({ length: config.tokenCount }, (_, index) =>
        mintPda(issuerId, index),
      )
      if (mints.length === 0) return []

      // One read for the mints and one for the configs, not two per token:
      // the console opens on this list, and the public node counts requests.
      const [mintInfos, configs] = await Promise.all([
        connection.getMultipleAccountsInfo(mints),
        program.account.tokenConfig.fetchMultiple(mints.map((mint) => tokenConfigPda(mint))),
      ])

      const listed: TokenListing[] = []
      for (const [index, mint] of mints.entries()) {
        const info = mintInfos[index]
        const token = configs[index]
        // A number taken but no mint behind it: the issuance transaction is
        // still in flight. Not a token yet.
        if (info === null || info === undefined || token === null || token === undefined) continue
        listed.push({
          ...toMintView(mint, info),
          index,
          policyVersion: token.policyVersion,
          pausedAt: token.pausedAt.isZero() ? null : token.pausedAt.toNumber(),
        })
      }
      return listed
    },

    async mint(mint) {
      const info = await connection.getAccountInfo(mint)
      if (info === null || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return undefined
      return toMintView(mint, info)
    },

    async freezes(mint) {
      // `mint` is the first field after the discriminator — written into the
      // record for exactly this filter (`state/freeze.rs`).
      const found = await program.account.freezeRecord.all([
        { memcmp: { offset: 8, bytes: mint.toBase58() } },
      ])
      const raws = found.map(({ account }) => account as RawFreeze)
      const amounts = await balances(raws.map((raw) => raw.tokenAccount))
      return raws
        .map((raw, index) => toFreeze(raw, amounts[index] ?? 0n))
        .sort((a, b) => b.frozenAt - a.frozenAt)
    },

    async freeze(tokenAccount) {
      const raw = (await program.account.freezeRecord.fetchNullable(
        freezeRecordPda(tokenAccount),
      )) as RawFreeze | null
      if (raw === null) return undefined
      const [amount] = await balances([tokenAccount])
      return toFreeze(raw, amount ?? 0n)
    },

    async tokenAccount(address) {
      const info = await connection.getAccountInfo(address)
      if (info === null || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return undefined
      try {
        const account = unpackAccount(address, info, TOKEN_2022_PROGRAM_ID)
        return {
          address: address.toBase58(),
          mint: account.mint.toBase58(),
          owner: account.owner.toBase58(),
          amount: account.amount,
          frozen: account.isFrozen,
        }
      } catch {
        // A mint, or anything else Token-2022 owns that is not an account.
        return undefined
      }
    },

    async seized(mint) {
      const vault = seizureVaultAddress(mint)
      const [amount] = await balances([vault])
      return { vault: vault.toBase58(), amount: amount ?? 0n }
    },
  }
}
