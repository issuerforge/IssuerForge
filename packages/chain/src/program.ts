import { type IdlAccounts, Program, type Provider } from '@coral-xyz/anchor'
import type { Connection } from '@solana/web3.js'
import { IDL, type IssuerForge } from './idl/issuer-forge.ts'

export type ForgeProgram = Program<IssuerForge>

/**
 * The program client: reading accounts and assembling instructions from the
 * IDL.
 *
 * The provider here is exactly `{ connection }`, with no wallet, and that is
 * deliberate. The package holds no key and cannot sign: transactions leave it
 * unsigned (T020), and the signature is put on by the wallet in the browser or
 * by the issuer's quorum. An `AnchorProvider` with a wallet would make
 * `program.methods.…rpc()` available everywhere, i.e. give the platform's
 * operational key a path to sign an action with funds — the thing the program
 * must not allow (FR-035a).
 */
export function createForgeProgram(connection: Connection): ForgeProgram {
  const provider: Provider = { connection }
  return new Program<IssuerForge>(IDL, provider)
}

/**
 * Account types straight from the IDL — the same source the program has.
 *
 * Only `IssuerConfig` for now: the IDL includes only the accounts at least one
 * instruction mentions, and `TokenConfig` arrives with `create_token` (T018).
 */
export type ForgeAccounts = IdlAccounts<IssuerForge>
export type IssuerConfigAccount = ForgeAccounts['issuerConfig']
