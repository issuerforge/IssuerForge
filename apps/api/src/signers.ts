// Choosing a signer among the issuer's membership.
//
// One rule for every handler: **addresses come from the membership, not from
// the request body**. The body can only narrow the choice to one of those
// already proven — the same thing `X-Issuer-Id` does for the tenant
// (`session.ts`). Otherwise "who signs" would become a field the client fills
// in.
//
// The function lived in `routes/tokens.ts` (T021) and moved here unchanged
// when a second route (`routes/holders.ts`, T022) started choosing a signer by
// the same rule: a copy would have diverged from the original exactly where
// the rule matters.
import type { RosterEntry } from './directory.ts'
import { invalidInput } from './errors.ts'

/**
 * One of the candidates for signing.
 *
 * An empty list is not a selection error, so the refusal code is decided by
 * the caller: "the membership has no attestor" and "this session has no admin"
 * are different things and different codes.
 */
export function chooseSigner(
  candidates: readonly RosterEntry[],
  requested: string | undefined,
  label: string,
): string | undefined {
  const wallets = candidates.map((entry) => entry.wallet)
  if (wallets.length === 0) return undefined

  if (requested === undefined) {
    const only = wallets[0]
    if (wallets.length === 1 && only !== undefined) return only
    throw invalidInput(`this issuer has several wallets that can sign as ${label}: name one`, {
      [label]: wallets,
    })
  }

  if (!wallets.includes(requested)) {
    throw invalidInput(`the wallet named as ${label} cannot sign in that role`, {
      [label]: wallets,
    })
  }
  return requested
}
