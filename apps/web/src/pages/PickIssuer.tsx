// Вибір емітента, коли ця адреса стоїть у складі кількох.
//
// Випадок не екзотичний: аудитор або юрист законно обслуговує двох емітентів
// однією адресою, і саме двома орендарями вимірюється SC-011.
//
// Перелік узятий із відмови api (`details.issuerIds`), а не з окремого запиту:
// сервер уже назвав, серед чого вибирати, і другого джерела правди про
// членства в консолі немає.
import { truncate } from '@/lib/format'

export default function PickIssuer({
  issuerIds,
  dropped,
  onPick,
}: {
  issuerIds: readonly string[]
  /** Раніше обраний емітент, який більше не називає цей гаманець у складі. */
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
