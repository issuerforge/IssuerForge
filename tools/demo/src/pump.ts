// A holder who keeps trying to move money while the officer acts — the SC-004
// measurement.
//
// SC-004 is not "the freeze transaction confirmed" but "the transfer is
// refused": the claim is about what the holder meets, so the run measures it
// from the holder's side. The pump sends one transfer a second, every one past
// preflight so that each lands in a block as a pass or a refusal, and reads
// their fate in one status request a second.
//
// **Its own connection, unpaced.** The context's connection queues every
// request behind a token bucket (`context.ts`); a timed path sharing that
// queue would measure the queue. Two requests a second stay well under the
// public node's limits on their own, and the officer's path is polled here
// too, for the same reason.
import { compileTransaction, type TxPlan, toPlan } from '@forge/chain'
import {
  ComputeBudgetProgram,
  Connection,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js'
import { unpacedFetch } from './context.ts'

export interface Shot {
  readonly signature: string
  /** Which target the shot was aimed at: a cycle reads only its own. */
  readonly label: string
  readonly sentAt: number
  state: 'pending' | 'passed' | 'refused' | 'dropped'
  slot?: number
  observedAt?: number
  /** `{ InstructionError: [i, { Custom: n }] }` as the node returned it. */
  error?: unknown
}

/** What the pump sends: one prepared transfer, the fee payer and its signers. */
export interface PumpTarget {
  readonly label: string
  readonly plan: TxPlan
  readonly feePayer: Keypair
  readonly signers: readonly Keypair[]
}

const INTERVAL_MS = 1_000
/** One batched status request per tick: 20 per 10 s, half the node's per-method limit. */
const WATCH_MS = 500
const BLOCKHASH_EVERY_MS = 20_000
/** Past a blockhash's life (~60–90 s) a transaction that did not land never will. */
const DROPPED_AFTER_MS = 90_000

export class TransferPump {
  readonly connection: Connection
  readonly shots: Shot[] = []
  private target: PumpTarget | undefined
  private running = false
  private sequence = 0
  private blockhash: { value: string; at: number } | undefined
  private loops: Promise<void>[] = []
  private readonly watched = new Map<
    string,
    (result: { slot: number; at: number; error: unknown }) => void
  >()

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed', fetch: unpacedFetch() })
  }

  /** Points the pump at a transfer; shots already in flight keep their fate. */
  aim(target: PumpTarget): void {
    this.target = target
  }

  /**
   * Stops aiming and waits until every shot has landed or dropped.
   *
   * Needed before reading a balance the pump itself moves: a transfer still
   * in flight lands after the read and quietly invalidates any amount computed
   * from it (the second run's seizures measured exactly that).
   */
  async hold(): Promise<void> {
    this.target = undefined
    while (this.shots.some((shot) => shot.state === 'pending')) await sleep(250)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.loops = [this.sendLoop(), this.watchLoop()]
  }

  /** Stops sending, then waits until every shot has landed or dropped. */
  async stop(): Promise<void> {
    this.running = false
    await Promise.all(this.loops)
    while (this.shots.some((shot) => shot.state === 'pending')) {
      await this.watch()
      await sleep(INTERVAL_MS)
    }
  }

  /** Resolves once `count` shots sent at or after `since` have landed as passes. */
  async passes(count: number, since: number, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.shots.filter((s) => s.sentAt >= since && s.state === 'passed').length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `the pump saw fewer than ${count} passing transfers in ${timeoutMs / 1000} s — the measurement has no baseline`,
        )
      }
      await sleep(250)
    }
  }

  /** Resolves with the first refused shot sent at or after `since`. */
  async firstRefusal(since: number, timeoutMs = 60_000): Promise<Shot> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const refused = this.shots
        .filter((s) => s.sentAt >= since && s.state === 'refused')
        .sort((a, b) => (a.observedAt ?? 0) - (b.observedAt ?? 0))[0]
      if (refused !== undefined) return refused
      if (Date.now() > deadline) throw new Error(`no refused transfer within ${timeoutMs / 1000} s`)
      await sleep(100)
    }
  }

  /**
   * Resolves when `signature` is confirmed: the officer's path, timed off the
   * same node and **the same status request** as the shots. A poll of its own
   * would double the requests of one method, and the public node's 429s on
   * that method would delay the observer, not the chain — exactly what the
   * first run measured.
   */
  confirmed(signature: string): Promise<{ slot: number; at: number; error: unknown }> {
    return new Promise((resolve) => {
      this.watched.set(signature, resolve)
    })
  }

  private async freshBlockhash(): Promise<string> {
    const now = Date.now()
    if (this.blockhash === undefined || now - this.blockhash.at > BLOCKHASH_EVERY_MS) {
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed')
      this.blockhash = { value: blockhash, at: now }
    }
    return this.blockhash.value
  }

  private async sendLoop(): Promise<void> {
    while (this.running) {
      const tick = Date.now()
      const target = this.target
      if (target !== undefined) {
        try {
          await this.fire(target)
        } catch (error) {
          // A send the node did not accept is not a shot: it never had a
          // chance to be refused. Said aloud so a run full of these reads as
          // a broken pump, not as a quiet one.
          console.warn(`         pump: send failed — ${(error as Error).message.split('\n')[0]}`)
        }
      }
      await sleep(Math.max(0, INTERVAL_MS - (Date.now() - tick)))
    }
  }

  private async fire(target: PumpTarget): Promise<void> {
    this.sequence += 1
    // A different price per shot keeps each message, and so each signature,
    // unique under one blockhash; at a micro-lamport it changes no fee that
    // matters.
    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.sequence }),
      ...target.plan.instructions,
    ]
    const transaction = compileTransaction(
      toPlan('transfer', target.feePayer.publicKey, instructions),
      await this.freshBlockhash(),
    )
    transaction.sign([target.feePayer, ...target.signers])
    const sentAt = Date.now()
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
    })
    this.shots.push({ signature, label: target.label, sentAt, state: 'pending' })
  }

  private async watchLoop(): Promise<void> {
    while (this.running) {
      const tick = Date.now()
      await this.watch().catch((error: unknown) => {
        console.warn(`         pump: status failed — ${(error as Error).message.split('\n')[0]}`)
      })
      await sleep(Math.max(0, WATCH_MS - (Date.now() - tick)))
    }
  }

  private async watch(): Promise<void> {
    const pending = this.shots.filter((shot) => shot.state === 'pending').slice(0, 200)
    const officer = [...this.watched.keys()]
    if (pending.length === 0 && officer.length === 0) return
    const { value } = await this.connection.getSignatureStatuses([
      ...pending.map((s) => s.signature),
      ...officer,
    ])
    const now = Date.now()
    const landed = (index: number) => {
      const status = value[index]
      return status !== null &&
        status !== undefined &&
        (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        ? status
        : undefined
    }
    pending.forEach((shot, index) => {
      const status = landed(index)
      if (status !== undefined) {
        shot.state = status.err === null ? 'passed' : 'refused'
        shot.slot = status.slot
        shot.observedAt = now
        if (status.err !== null) shot.error = status.err
      } else if (now - shot.sentAt > DROPPED_AFTER_MS) {
        shot.state = 'dropped'
      }
    })
    officer.forEach((signature, offset) => {
      const status = landed(pending.length + offset)
      if (status === undefined) return
      this.watched.get(signature)?.({ slot: status.slot, at: now, error: status.err })
      this.watched.delete(signature)
    })
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
