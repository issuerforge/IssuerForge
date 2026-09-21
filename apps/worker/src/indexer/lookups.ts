// The decoder's questions, answered by the network.
//
// Every answer here is about an account that never changes once written —
// an `IssuerConfig`'s `issuer_id`, a `TokenConfig`'s mint and issuer, a
// policy version's rules, an attestation's index — so each is read once per
// process and kept. The one exception, a token account's owner, is not kept:
// it is asked only when the transaction's balances did not name it, which
// is rare enough that a cache would be a place for a stale answer to hide.
import { createForgeProgram, PROGRAM_ID, tokenConfigPda } from '@forge/chain'
import { RULE_SLOT_BYTES } from '@forge/policy/model'
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { type Connection, PublicKey } from '@solana/web3.js'
import type { Lookups, TokenView } from './decode.ts'

/** Anchor throws on a discriminator that is not the account's; the decoder asked "is it one?", not "read it". */
async function nullable<T>(read: () => Promise<T | null>): Promise<T | undefined> {
  try {
    return (await read()) ?? undefined
  } catch {
    return undefined
  }
}

function memoised<T>(read: (address: string) => Promise<T | undefined>) {
  const known = new Map<string, T>()
  return async (address: string): Promise<T | undefined> => {
    const hit = known.get(address)
    if (hit !== undefined) return hit
    const value = await read(address)
    if (value !== undefined) known.set(address, value)
    return value
  }
}

/** The IDL's zero-copy `PolicyConfig` decodes its slots as objects; the layout wants them back as bytes. */
type RuleSlot = { kind: number; op: number; params: number[] }

function rulesToBytes(slots: readonly RuleSlot[]): Uint8Array {
  const bytes = new Uint8Array(slots.length * RULE_SLOT_BYTES)
  slots.forEach((slot, index) => {
    bytes.set([slot.kind, slot.op, ...slot.params], index * RULE_SLOT_BYTES)
  })
  return bytes
}

export function createRpcLookups(connection: Connection): Lookups {
  // The same client the api reads with: the IDL names the accounts in camelCase.
  const { account } = createForgeProgram(connection)

  const issuerIdOfConfig = memoised(async (address) => {
    const config = await nullable(() => account.issuerConfig.fetchNullable(new PublicKey(address)))
    return config?.issuerId.toBase58()
  })

  const tokenOfConfig = memoised(async (address): Promise<TokenView | undefined> => {
    const config = await nullable(() => account.tokenConfig.fetchNullable(new PublicKey(address)))
    if (config === undefined) return undefined
    const issuerId = await issuerIdOfConfig(config.issuer.toBase58())
    if (issuerId === undefined) return undefined
    return {
      mint: config.mint.toBase58(),
      issuerId,
      attestationMaxAge: config.attestationMaxAge.toNumber(),
    }
  })

  const policyRulesAt = memoised(async (address) => {
    const policy = await nullable(() => account.policyConfig.fetchNullable(new PublicKey(address)))
    return policy === undefined ? undefined : rulesToBytes(policy.rules as RuleSlot[])
  })

  const attestationIndexAt = memoised(async (address) => {
    const attestation = await nullable(() =>
      account.reserveAttestation.fetchNullable(new PublicKey(address)),
    )
    return attestation?.index.toNumber()
  })

  return {
    issuerIdOfConfig,
    tokenOfConfig,
    tokenOfMint: (mint) =>
      tokenOfConfig(tokenConfigPda(new PublicKey(mint), PROGRAM_ID).toBase58()),
    policyRulesAt,
    attestationIndexAt,
    async ownerOfTokenAccount(address) {
      const key = new PublicKey(address)
      const info = await connection.getAccountInfo(key, 'confirmed')
      if (info === null) return undefined
      try {
        return unpackAccount(key, info, TOKEN_2022_PROGRAM_ID).owner.toBase58()
      } catch {
        return undefined
      }
    },
  }
}
