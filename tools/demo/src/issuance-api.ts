// Issuance through the api — the same path the wizard takes in the browser.
//
// The difference from `issuance.ts` is not in the result but in **what
// exactly is measured**. The direct path assembles the three transactions in
// this very process; here the server assembles them, and the SC-001 time
// includes everything in between: login, membership, reserving a number in
// the database, the response, and only then three signatures and three
// confirmations.
//
// The transactions arrive unsigned (SC-012), and the blockhash is one for all
// three: a person signs them in one wizard action, and three lifetimes would
// mean the third goes stale in the queue (decision T021).
import type { CreateTokenBody } from '@forge/api/contracts'
import { fromBase64 } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { PublicKey } from '@solana/web3.js'
import type { ApiClient } from './api.ts'
import { chainTime, type DemoContext } from './context.ts'
import { type Sent, send } from './send.ts'

export interface ApiIssuanceInput {
  readonly decimals: number
  readonly policy: PolicyRules
  readonly initialSupply: bigint
  readonly reserveAmount: bigint
  readonly reserveCurrency: string
  readonly feeBps: number
  readonly attestationMaxAge: number
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

export interface ApiIssuanceResult {
  readonly mint: PublicKey
  readonly tokenIndex: number
  readonly steps: readonly Sent[]
  /** Milliseconds from the api request to the confirmation of the third transaction. */
  readonly elapsedMs: number
  /** How much of that went on the api response itself — the rest is the network. */
  readonly apiMs: number
}

export async function issueViaApi(
  context: DemoContext,
  api: ApiClient,
  input: ApiIssuanceInput,
): Promise<ApiIssuanceResult> {
  const { connection, keys } = context

  // The time is taken from the chain, not from the host clock:
  // `Clock::unix_timestamp` is derived from slots and lags, and an
  // attestation "from the future" is rejected by both the route and the
  // program (debt T021 #6).
  const attestedAt = await chainTime(connection)

  const body: CreateTokenBody = {
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    decimals: input.decimals,
    policy: input.policy,
    initialSupply: input.initialSupply.toString(),
    reserve: {
      amount: input.reserveAmount.toString(),
      currency: input.reserveCurrency,
      attestedAt,
    },
    attestation: {
      // The fixture credential and schema are the same as on the direct path:
      // there is no attestation service, but the addresses must be real keys.
      credential: keys.issuerId.publicKey.toBase58(),
      schema: keys.treasury.publicKey.toBase58(),
      maxAgeSeconds: input.attestationMaxAge,
    },
    fee: { treasury: keys.treasury.publicKey.toBase58(), bps: input.feeBps },
    founderStatus: { tier: 2, jurisdiction: 'NG', expiresAt: 0 },
  }

  const startedAt = Date.now()
  const plan = await api.createToken(body)
  const apiMs = Date.now() - startedAt

  const signable = [keys.founder, keys.attestor]
  const steps: Sent[] = []

  for (const unsigned of plan.transactions) {
    const transaction = fromBase64(unsigned.base64)
    // The keys are picked by the addresses the server named, not by a guess
    // about the order: `signers` are derived from the instructions (T020),
    // and a second list here would diverge exactly when an instruction gains
    // a new signer.
    transaction.sign(
      signable.filter((keypair) => unsigned.signers.includes(keypair.publicKey.toBase58())),
    )
    // Sequentially: `dependsOnPrevious` is a ban on sending as a batch.
    steps.push(await send(connection, transaction))
  }

  return {
    mint: new PublicKey(plan.mint),
    tokenIndex: plan.tokenIndex,
    steps,
    elapsedMs: Date.now() - startedAt,
    apiMs,
  }
}
