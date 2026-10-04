// The officer's handlers: the issuer's tokens, a token's compliance totals,
// and the freeze with its lifting (FR-014, FR-016, FR-020).
//
// **A freeze is the officer's alone.** One signature, no quorum, no proposal —
// it moves no funds (T026). It is not a routine power either: the program's
// `require_officer` accepts the COMPLIANCE role and nothing else, so there is
// no delegated path here and the operational key is not even consulted. The
// handler returns an unsigned transaction for the officer's wallet, the same
// as the quorum routes.
//
// **Pre-checks say early what the program says late.** A token account of
// another mint, an account already frozen, a lifting with no freeze — the
// program refuses each of them, and the route refuses first so that the
// officer does not sign and pay for a refusal. Nothing here is the authority.
import {
  buildFreezeHolder,
  buildUnfreezeHolder,
  issuerConfigPda,
  MAX_TRANSACTION_BYTES,
  type TxPlan,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { hasRole, ROLE, type Session } from '@forge/shared/api'
import { addressSchema, fromU64 } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import type { z } from 'zod'
import type { ActionReader } from '../actions.ts'
import type { ChainReader } from '../chain.ts'
import type { ComplianceReader, FreezeView, TokenListing } from '../compliance.ts'
import { signerQuerySchema } from '../contracts/actions.ts'
import {
  type ComplianceSummary,
  type FreezeResponse,
  freezeBodySchema,
  type OfficerTransactionResponse,
  unfreezeBodySchema,
} from '../contracts/compliance.ts'
import type { Directory } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import { chooseSigner } from '../signers.ts'

export interface ComplianceRouteDeps {
  chain: ChainReader
  actions: ActionReader
  compliance: ComplianceReader
  directory: Directory
}

export function createComplianceRoutes(deps: ComplianceRouteDeps) {
  const app = new Hono<AppEnv>()

  const body = <S extends z.ZodType>(schema: S) =>
    zValidator('json', schema, (result) => {
      if (!result.success) throw result.error
    })

  const query = <S extends z.ZodType>(schema: S) =>
    zValidator('query', schema, (result) => {
      if (!result.success) throw result.error
    })

  /** The same ownership rule as the quorum routes: another issuer's token does not exist (SC-011). */
  const requireToken = async (session: Session, mint: string) => {
    const token = await deps.actions.token(new PublicKey(mint))
    const own = issuerConfigPda(new PublicKey(session.issuerId)).toBase58()
    if (token === undefined || token.issuerConfig !== own) {
      throw notFound('this issuer has no such token')
    }
  }

  /**
   * The officer's wallet: one of this session's, an officer in the roster
   * **and** on chain — the second for the same reason as `sessionSigner` in
   * the quorum routes: the roster is a mirror, and the program reads the
   * chain.
   */
  const officerSigner = async (session: Session, requested: string | undefined) => {
    if (!hasRole(session.roles, ROLE.COMPLIANCE)) {
      // An admin is refused too, and that is the program's rule, not ours:
      // separation of duties puts a freeze in the officer's hands (FR-014).
      throw unauthorized('only a compliance officer freezes an account')
    }
    const roster = await deps.directory.rosterFor(session.issuerId)
    const signer = chooseSigner(
      roster.filter(
        (entry) => hasRole(entry.roles, ROLE.COMPLIANCE) && session.wallets.includes(entry.wallet),
      ),
      requested,
      'officer',
    )
    if (signer === undefined) {
      throw unauthorized('no wallet of this session is a compliance officer of this issuer')
    }
    const quorum = await deps.actions.quorum(new PublicKey(session.issuerId))
    const onChain = quorum?.members.find((member) => member.wallet === signer)
    if (onChain === undefined || !hasRole(onChain.roles, ROLE.COMPLIANCE)) {
      throw invalidInput('this wallet is not a compliance officer on chain', { officer: signer })
    }
    return signer
  }

  const respond = async (
    plan: TxPlan,
    tokenAccount: string,
    signer: string,
  ): Promise<OfficerTransactionResponse> => {
    const blockhash = await deps.chain.latestBlockhash()
    const unsigned = toUnsigned(plan, blockhash)
    const bytes = transactionBytes(unsigned.transaction)
    if (bytes > MAX_TRANSACTION_BYTES) {
      throw internal(`${plan.step} does not fit in a transaction`, {
        bytes,
        limit: MAX_TRANSACTION_BYTES,
      })
    }
    return {
      tokenAccount,
      signer,
      blockhash,
      transaction: {
        step: unsigned.step,
        base64: unsigned.base64,
        signers: unsigned.signers.map((key) => key.toBase58()),
        dependsOnPrevious: unsigned.dependsOnPrevious,
        bytes,
      },
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * This issuer's tokens, from the chain: `token_count` and the mint PDAs.
   * A read — membership is enough. The console has no other way to learn its
   * mints: they are derived, never typed.
   */
  app.get('/tokens', async (c) => {
    const session = c.get('session')
    const tokens = await deps.compliance.tokens(new PublicKey(session.issuerId))
    if (tokens === undefined) throw notFound('this issuer has no IssuerConfig on chain yet')
    return c.json({ tokens: tokens.map(presentToken) })
  })

  /** The totals FR-020 asks to keep apart: free, frozen by an officer, seized. */
  app.get('/tokens/:mint/compliance', async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    await requireToken(session, mint)

    const key = new PublicKey(mint)
    const [view, freezes, seized] = await Promise.all([
      deps.compliance.mint(key),
      deps.compliance.freezes(key),
      deps.compliance.seized(key),
    ])
    if (view === undefined) throw notFound('this issuer has no such token')

    const frozen = freezes.reduce((sum, freeze) => sum + freeze.amount, 0n)
    // Never below zero, though it cannot be: the vault and the frozen accounts
    // are accounts of this mint, and their sum is part of the supply. A
    // negative here would be a bug in a read, and showing it as a huge u64
    // would hide it.
    const free = view.supply - frozen - seized.amount
    if (free < 0n) {
      throw internal('the frozen and seized balances exceed the supply', {
        supply: fromU64(view.supply),
        frozen: fromU64(frozen),
        seized: fromU64(seized.amount),
      })
    }

    return c.json({
      mint,
      decimals: view.decimals,
      supply: fromU64(view.supply),
      paused: view.paused,
      frozen: { amount: fromU64(frozen), accounts: freezes.map(presentFreeze) },
      seized: { vault: seized.vault, amount: fromU64(seized.amount) },
      free: fromU64(free),
    } satisfies ComplianceSummary)
  })

  // ─── Writes ────────────────────────────────────────────────────────────────

  app.post('/tokens/:mint/freezes', query(signerQuerySchema), body(freezeBodySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    await requireToken(session, mint)
    const officer = await officerSigner(session, c.req.valid('query').signer)
    const input = c.req.valid('json')

    const mintKey = new PublicKey(mint)
    const tokenAccount =
      'wallet' in input
        ? getAssociatedTokenAddressSync(
            mintKey,
            new PublicKey(input.wallet),
            // A PDA can hold the token too — the issuer's own vault is one —
            // and its associated account is derived the same way.
            true,
            TOKEN_2022_PROGRAM_ID,
          )
        : new PublicKey(input.tokenAccount)

    const account = await deps.compliance.tokenAccount(tokenAccount)
    if (account === undefined || account.mint !== mint) {
      throw invalidInput(
        'wallet' in input
          ? 'this wallet has no account for this token'
          : 'this is not an account of this token',
        { tokenAccount: tokenAccount.toBase58() },
      )
    }
    if ((await deps.compliance.freeze(tokenAccount)) !== undefined) {
      throw invalidInput('an officer has already frozen this account', {
        tokenAccount: tokenAccount.toBase58(),
      })
    }

    const plan = await buildFreezeHolder(deps.chain.program, {
      issuerId: new PublicKey(session.issuerId),
      mint: mintKey,
      tokenAccount,
      // The officer pays the record's rent and gets it back on lifting: the
      // platform's key stays out of a compliance action even as a payer.
      payer: new PublicKey(officer),
      officer: new PublicKey(officer),
      reason: input.reason,
    })

    c.get('log').info(
      { mint, tokenAccount: tokenAccount.toBase58(), officer, code: input.reason.code },
      'freeze assembled',
    )
    return c.json(await respond(plan, tokenAccount.toBase58(), officer))
  })

  app.post(
    '/tokens/:mint/freezes/:tokenAccount/unfreeze',
    query(signerQuerySchema),
    body(unfreezeBodySchema),
    async (c) => {
      const session = c.get('session')
      const mint = addressParam(c.req.param('mint'), 'mint')
      const tokenAccount = addressParam(c.req.param('tokenAccount'), 'token account')
      await requireToken(session, mint)
      const officer = await officerSigner(session, c.req.valid('query').signer)

      const record = await deps.compliance.freeze(new PublicKey(tokenAccount))
      // A record of another mint is "no such freeze" for this token: the path
      // names the mint, and the token check above was about that mint.
      if (record === undefined || record.mint !== mint) {
        throw notFound('no officer has frozen this account', { tokenAccount })
      }

      const plan = await buildUnfreezeHolder(deps.chain.program, {
        issuerId: new PublicKey(session.issuerId),
        mint: new PublicKey(mint),
        tokenAccount: new PublicKey(tokenAccount),
        // Pinned by the program to the record's payer; read, not chosen.
        rentRecipient: new PublicKey(record.payer),
        officer: new PublicKey(officer),
        reason: c.req.valid('json').reason,
      })

      c.get('log').info({ mint, tokenAccount, officer }, 'unfreeze assembled')
      return c.json(await respond(plan, tokenAccount, officer))
    },
  )

  return app
}

// ─── Small conversions ───────────────────────────────────────────────────────

function presentToken(token: TokenListing) {
  return {
    mint: token.mint,
    index: token.index,
    decimals: token.decimals,
    supply: fromU64(token.supply),
    paused: token.paused,
    pausedAt: token.pausedAt,
    name: token.name,
    symbol: token.symbol,
    policyVersion: token.policyVersion,
  }
}

function presentFreeze(freeze: FreezeView): FreezeResponse {
  return {
    tokenAccount: freeze.tokenAccount,
    wallet: freeze.wallet,
    officer: freeze.officer,
    payer: freeze.payer,
    reason: freeze.reason,
    frozenAt: freeze.frozenAt,
    wasThawed: freeze.wasThawed,
    amount: fromU64(freeze.amount),
  }
}

/** The same guard as in the other routes: a typo in the path is a 400, not a 500. */
function addressParam(value: string | undefined, label: string): string {
  const parsed = addressSchema.safeParse(value)
  if (!parsed.success) throw invalidInput(`${label} is not a base58 address`)
  return parsed.data
}
