// The run environment: the network, the keys, the money for rent.
//
// **The keys are generated on every run and stored nowhere.** The demo
// creates its own issuer from scratch — that is exactly what SC-001 measures
// ("on a clean account"). A persistent key would make the second run cheaper
// than the first, i.e. spoil the measurement everything is done for.
//
// `--payer` does not change that: the deploy wallet only **tops up** the
// fresh keys instead of the faucet, while the same one-off keys still sign
// and own everything.
import { readFileSync } from 'node:fs'
import { createForgeProgram, decodeBase58, type ForgeProgram } from '@forge/chain'
import {
  Connection,
  type FetchFn,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SystemProgram,
} from '@solana/web3.js'
import { submit } from './send.ts'

export interface DemoKeys {
  /** The payer of rent and fees. Also the founder-admin. */
  readonly founder: Keypair
  /**
   * The compliance officer: the second signature of the quorum.
   *
   * Not a decoration of the membership: `quorum_n = 2` requires **two**
   * authorised members, and the attestor is not one of them — FR-024 gives
   * them no other powers. The program does not create an issuer with only a
   * founder at all.
   */
  readonly officer: Keypair
  /** The attestor role: signs the reserve attestation alongside the founder. */
  readonly attestor: Keypair
  /** The platform's operational key. In the demo it lives here, in the product in the api. */
  readonly operational: Keypair
  /** The issuer identifier: the seed of its PDA, signs nothing. */
  readonly issuerId: Keypair
  /** The platform treasury: the issuance fee goes here. */
  readonly treasury: Keypair
  /** Two holders: transfers go between them, and refusals are measured on them. */
  readonly alice: Keypair
  readonly bob: Keypair
  /** A jurisdiction outside the allowed ones. */
  readonly carol: Keypair
  /** Denied in the issuer's own registry. */
  readonly dave: Keypair
  /** The one the issuer never let in: none of their transfers may pass. */
  readonly stranger: Keypair
}

export interface DemoContext {
  readonly connection: Connection
  readonly program: ForgeProgram
  readonly keys: DemoKeys
  readonly cluster: string
}

export function newKeys(): DemoKeys {
  return {
    founder: Keypair.generate(),
    officer: Keypair.generate(),
    attestor: Keypair.generate(),
    operational: Keypair.generate(),
    issuerId: Keypair.generate(),
    treasury: Keypair.generate(),
    alice: Keypair.generate(),
    bob: Keypair.generate(),
    carol: Keypair.generate(),
    dave: Keypair.generate(),
    stranger: Keypair.generate(),
  }
}

/**
 * The node request limit: burst and refill rate.
 *
 * Public devnet cuts with two counters — ~100 requests per 10 seconds in
 * total and ~40 per 10 seconds per **single method** — while a full run is
 * over a hundred transactions and as many reads. Without a limit the
 * measurement would show not the rule at work but `429`: it arrives instead
 * of the program's refusal and lands in the report as "the attempt did not
 * assemble".
 *
 * **Why a bucket and not an even interval.** An even interval taxes the
 * issuance too, and the issuance is SC-001, i.e. the number the demo exists
 * for. The first devnet run with a 120 ms interval gave 10.0 s instead of
 * the 1.2 s local, and almost all the difference was back-offs after `429`,
 * not the chain. The bucket lets the first thirty requests through with no
 * delay (the issuance fits in entirely) and holds back only the long attack
 * and comparison loops, where time measures nothing.
 *
 * Three requests per second is 30 per ten, i.e. below the smaller of the two
 * counters even in the worst case, when all requests are of one method.
 */
const NODE_LIMIT = { burst: 30, perSecond: 3 } as const

const isLocal = (rpcUrl: string): boolean =>
  rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')

/**
 * `fetch` with a token bucket. `limit === undefined` — no limit.
 *
 * The queue is needed so that two concurrent requests do not take one token
 * twice. The retry on `429` is done by web3.js itself (`Retry-After`), and
 * those retries take tokens too — otherwise the back-off would accelerate
 * exactly what it is running from.
 */
function pacedFetch(limit: { burst: number; perSecond: number } | undefined): FetchFn {
  let queue: Promise<void> = Promise.resolve()
  let tokens = limit?.burst ?? 0
  let filled = Date.now()

  const take = async (rate: { burst: number; perSecond: number }): Promise<void> => {
    const now = Date.now()
    tokens = Math.min(rate.burst, tokens + ((now - filled) / 1000) * rate.perSecond)
    filled = now
    if (tokens < 1) {
      await new Promise((resolve) => setTimeout(resolve, ((1 - tokens) / rate.perSecond) * 1000))
      filled = Date.now()
    }
    tokens = Math.max(0, tokens - 1)
  }

  const paced = async (input: unknown, init: unknown): Promise<unknown> => {
    if (limit !== undefined) {
      const turn = queue.then(() => take(limit))
      queue = turn
      await turn
    }
    return await fetch(input as string, init as RequestInit)
  }

  // `FetchFn` is described with node-fetch's types, while at runtime it is
  // Node's global `fetch`. The cast sits exactly on this boundary and nowhere
  // else.
  return paced as unknown as FetchFn
}

export function createContext(rpcUrl: string, overrides: Partial<DemoKeys> = {}): DemoContext {
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: pacedFetch(isLocal(rpcUrl) ? undefined : NODE_LIMIT),
  })
  return {
    connection,
    program: createForgeProgram(connection),
    // The override exists for exactly one key and one reason: on the `--api`
    // path the operational key is owned by the api process, not the demo. A
    // key generated here would not match the `operational_key` the program
    // checks, and every delegated thaw would be refused.
    keys: { ...newKeys(), ...overrides },
    cluster: rpcUrl,
  }
}

/** An ed25519 secret key in base58 (the `OPERATIONAL_SECRET_KEY` format) → `Keypair`. */
export function keypairFromBase58(secret: string): Keypair {
  return Keypair.fromSecretKey(decodeBase58(secret))
}

/**
 * A key from a `solana-keygen` file: an array of 64 bytes in JSON.
 *
 * The format is checked here, not by the first transaction: "invalid
 * signature" five minutes into the run does not say what is wrong with the
 * file.
 */
export function loadKeypair(path: string): Keypair {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(`${path}: expected a solana keypair file — a JSON array of 64 bytes`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]))
}

/**
 * Pours in SOL: by transfer from the wallet if one is named, otherwise from
 * the faucet.
 *
 * On the local validator an airdrop is free and instant. On devnet it is
 * rate-limited, which is exactly why `--payer` exists: the deploy wallet
 * already has funds, and the run takes them from there instead of queuing at
 * the faucet.
 *
 * A failed airdrop does **not** stop the run: it merely adds no money, and
 * whether it is short will be said by the very first transaction. A failed
 * transfer from the wallet, on the contrary, stops it: a named wallet that
 * could not be drawn from is a launch error, not a property of the network.
 */
export async function fund(
  connection: Connection,
  address: PublicKey,
  sol: number,
  payer?: Keypair,
): Promise<boolean> {
  if (payer !== undefined) {
    await submit(
      connection,
      payer.publicKey,
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: address,
          lamports: Math.round(sol * LAMPORTS_PER_SOL),
        }),
      ],
      [payer],
    )
    return true
  }

  try {
    const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    return true
  } catch {
    return false
  }
}

export const solOf = (lamports: number): number => lamports / LAMPORTS_PER_SOL

/**
 * Time as the **program** sees it, not the host.
 *
 * `Clock::unix_timestamp` is not equal to the machine clock: it is derived
 * from slots and lags when the validator runs longer than one run. A
 * difference of seconds is enough for `create_token` to reject the reserve
 * attestation as "dated in the future" — and that is exactly what happened
 * on the very first run (debt T021 #6, now confirmed).
 *
 * `getBlockTime` returns `null` for a slot that has no time yet; then the
 * host clock is taken — worse, but better than stopping the measurement.
 */
export async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot('confirmed')
  const time = await connection.getBlockTime(slot)
  return time ?? Math.floor(Date.now() / 1000)
}
