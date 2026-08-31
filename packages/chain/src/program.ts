import { type IdlAccounts, Program, type Provider } from '@coral-xyz/anchor'
import type { Connection } from '@solana/web3.js'
import { IDL, type IssuerForge } from './idl/issuer-forge.ts'

export type ForgeProgram = Program<IssuerForge>

/**
 * Клієнт програми: читання акаунтів і збірка інструкцій за IDL.
 *
 * Провайдер тут — рівно `{ connection }`, без гаманця, і це навмисно. Пакет не
 * тримає ключа й не вміє підписувати: транзакції з нього виходять
 * непідписаними (T020), а підпис ставить гаманець у браузері або кворум
 * емітента. `AnchorProvider` із гаманцем зробив би `program.methods.…rpc()`
 * доступним звідусіль, тобто дав би операційному ключу платформи шлях
 * підписати дію з коштами — те, чого програма не має дозволяти (FR-035a).
 */
export function createForgeProgram(connection: Connection): ForgeProgram {
  const provider: Provider = { connection }
  return new Program<IssuerForge>(IDL, provider)
}

/**
 * Типи акаунтів прямо з IDL — джерело те саме, що й у програми.
 *
 * Тут поки лише `IssuerConfig`: в IDL потрапляють тільки ті акаунти, які згадує
 * хоч одна інструкція, а `TokenConfig` з'явиться з `create_token` (T018).
 */
export type ForgeAccounts = IdlAccounts<IssuerForge>
export type IssuerConfigAccount = ForgeAccounts['issuerConfig']
