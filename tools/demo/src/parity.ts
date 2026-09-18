// Simulation against the network — the SC-008 measurement at runtime.
//
// **T019 compared the model with the model; here the model is compared with
// what the chain actually answers.** The difference matters: the differential
// tests prove that two implementations are the same, while this pass proves
// that both match **the token program and the hook at runtime** — with real
// accounts, a real `Clock` and a real window counter.
//
// Every scenario runs twice: `simulateTransfer` in TS and a real transfer on
// the network. A divergence is either a false simulation in the wizard (the
// person would have signed something other than what they saw) or a spurious
// refusal on the network.
import { buildTransfer, velocityCounterPda } from '@forge/chain'
import {
  type PolicyRules,
  simulateTransfer,
  type TransferContext,
  type TransferVerdict,
} from '@forge/policy'
import { refusalCodeFromAnchorError } from '@forge/shared/refusal'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext } from './context.ts'
import { expectRefusal, PassedThrough, submitPlan } from './send.ts'

/** A party to the transfer as both the simulation and the network see it. */
export interface Party {
  readonly wallet: Keypair
  readonly tier: number
  readonly jurisdiction: string
  readonly denied: boolean
  /** The account is created but not thawed: there is no status in the registry. */
  readonly unregistered: boolean
}

export interface Scenario {
  readonly name: string
  readonly recipient: Party
  readonly amount: bigint
}

export interface ParityRow {
  readonly name: string
  readonly simulated: TransferVerdict
  readonly onChain: TransferVerdict
  readonly agrees: boolean
  /** The error number, if the network refused with a code that is not ours. */
  readonly foreignCode: number | undefined
}

export interface ParityReport {
  readonly rows: readonly ParityRow[]
  readonly total: number
  readonly agreed: number
}

/**
 * The state of one party for the simulation.
 *
 * The `provider` source is always `absent`: the demo policy does not accept
 * it, and putting a record there would mean simulating a rule that does not
 * exist.
 */
const partyContext = (party: Party) => ({
  provider: { kind: 'absent' as const },
  register: party.unregistered
    ? { kind: 'absent' as const }
    : {
        kind: 'record' as const,
        record: {
          denied: party.denied,
          tier: party.tier,
          jurisdiction: party.jurisdiction,
          expiresAt: null,
        },
      },
})

export interface ParityInput {
  readonly mint: PublicKey
  readonly decimals: number
  readonly policy: PolicyRules
  readonly sender: Party
  readonly scenarios: readonly Scenario[]
  readonly policyVersion: number
}

export async function checkParity(context: DemoContext, input: ParityInput): Promise<ParityReport> {
  const { connection } = context
  const rows: ParityRow[] = []

  for (const scenario of input.scenarios) {
    const now = await chainTime(connection)

    // The window counter is read **from the chain** before every scenario,
    // not tracked alongside. Otherwise the comparison would prove that the
    // model matches our own idea of the state rather than what the hook sees:
    // an allowed transfer moves the counter, and a second attempt in the same
    // window is already different.
    const counter = await context.program.account.velocityCounter.fetchNullable(
      velocityCounterPda(input.mint, input.sender.wallet.publicKey),
    )

    const transferContext: TransferContext = {
      sender: partyContext(input.sender),
      recipient: partyContext(scenario.recipient),
      amount: scenario.amount.toString(),
      velocity:
        counter === null
          ? undefined
          : {
              windowStart: counter.windowStart.toNumber(),
              spentInWindow: counter.spentInWindow.toString(),
            },
      mintPolicyVersion: input.policyVersion,
      policyVersion: input.policyVersion,
      now,
    }

    // The token is not paused and the sender's account is thawed; a frozen
    // recipient account is a separate state, and `unregistered` is what
    // carries it.
    const simulated = simulateTransfer(input.policy, transferContext, {
      paused: false,
      senderFrozen: false,
      recipientFrozen: scenario.recipient.unregistered,
    })

    const onChain = await run(context, input, scenario)

    rows.push({
      name: scenario.name,
      simulated,
      onChain: onChain.verdict,
      // A match is both the same verdict and the same **code**: "refused for
      // a different reason" is a divergence, not half a success.
      agrees: sameVerdict(simulated, onChain.verdict),
      foreignCode: onChain.foreignCode,
    })
  }

  return { rows, total: rows.length, agreed: rows.filter((row) => row.agrees).length }
}

const sameVerdict = (left: TransferVerdict, right: TransferVerdict): boolean =>
  left.allowed === right.allowed && (left.allowed || right.allowed || left.code === right.code)

/** The same transfer on the network; the verdict is reduced to the same shape. */
async function run(
  context: DemoContext,
  input: ParityInput,
  scenario: Scenario,
): Promise<{ verdict: TransferVerdict; foreignCode: number | undefined }> {
  const { connection } = context

  const plan = await buildTransfer(connection, {
    mint: input.mint,
    owner: input.sender.wallet.publicKey,
    recipient: scenario.recipient.wallet.publicKey,
    amount: scenario.amount,
    decimals: input.decimals,
  })

  // An allowed transfer must be **executed**, not merely attempted: otherwise
  // "allowed" is proven by the absence of a refusal, not by the result.
  try {
    const refusal = await expectRefusal(
      connection,
      input.sender.wallet.publicKey,
      plan.instructions,
      [input.sender.wallet],
    )
    const code = refusal.code === undefined ? null : refusalCodeFromAnchorError(refusal.code)

    return code === null
      ? // A refusal with a code that is not ours: a frozen account (`0x11`) is
        // the first gate of FR-008b, and in the model it maps to `ACCOUNT_FROZEN`.
        {
          verdict: { allowed: false, code: 'ACCOUNT_FROZEN' },
          foreignCode: refusal.code,
        }
      : { verdict: { allowed: false, code }, foreignCode: undefined }
  } catch (error) {
    if (error instanceof PassedThrough) {
      return { verdict: { allowed: true }, foreignCode: undefined }
    }
    throw error
  }
}

/** A transfer that really must go through: it is executed, not merely checked. */
export async function moveOnce(
  context: DemoContext,
  mint: PublicKey,
  decimals: number,
  sender: Keypair,
  recipient: PublicKey,
  amount: bigint,
): Promise<void> {
  const plan = await buildTransfer(context.connection, {
    mint,
    owner: sender.publicKey,
    recipient,
    amount,
    decimals,
  })
  await submitPlan(context.connection, plan, [sender])
}
