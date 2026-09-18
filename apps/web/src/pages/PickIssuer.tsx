// Choosing the issuer when this address is in several memberships.
//
// The case is not exotic: an auditor or a lawyer legitimately serves two
// issuers with one address, and SC-011 is measured with exactly two tenants.
//
// The list is taken from the api's refusal (`details.issuerIds`), not from a
// separate request: the server has already named what to choose from, and
// the console has no second source of truth about memberships.
import { truncate } from '@/lib/format'

export default function PickIssuer({
  issuerIds,
  dropped,
  onPick,
}: {
  issuerIds: readonly string[]
  /** The previously chosen issuer that no longer names this wallet in its membership. */
  dropped?: string | undefined
  onPick: (issuerId: string) => void
}) {
  return (
    <div className="mx-auto max-w-[560px] px-5 py-24">
      <h1 className="section-head block">This wallet belongs to more than one issuer</h1>

      {dropped !== undefined && (
        <p className="refuse mt-5 text-[13px] leading-relaxed">
          The issuer you had open, <span className="num">{truncate(dropped)}</span>, no longer lists
          this wallet in its roster. A quorum of that issuer’s wallets can change a roster at any
          time, and the console reads it fresh on every request.
        </p>
      )}

      <p className="mt-5 text-[13px] leading-relaxed">
        Pick the one you are working on. Your role is read separately for each, and nothing you do
        under one is visible under the other.
      </p>

      <ul className="mt-8">
        {issuerIds.map((issuerId) => (
          <li key={issuerId} className="border-b border-hairline">
            <button
              type="button"
              onClick={() => onPick(issuerId)}
              className="flex w-full items-baseline justify-between gap-4 py-3 text-left"
            >
              <span className="mono12 break-all">{truncate(issuerId)}</span>
              <span className="smallcaps muted">Open</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
