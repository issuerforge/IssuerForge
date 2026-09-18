// A single-screen notice: waiting, refusal, failure.
//
// One component for all three, because they differ only in text, not in
// shape. `requestId` is shown whenever there is one: it finds the api log
// line unambiguously, and it is the only thing worth reading out over the
// phone.
import { usePrivy } from '@privy-io/react-auth'

export default function Notice({
  title,
  body,
  requestId,
  signOut = false,
}: {
  title: string
  body?: string | undefined
  requestId?: string | undefined
  signOut?: boolean | undefined
}) {
  const { logout } = usePrivy()

  return (
    <div className="mx-auto max-w-[560px] px-5 py-24">
      <h1 className="section-head block">{title}</h1>
      {body && <p className="mt-5 text-[13px] leading-relaxed">{body}</p>}
      {requestId && (
        <p className="mono12 muted mt-5 break-all">
          request <span className="num">{requestId}</span>
        </p>
      )}
      {signOut && (
        <p className="mt-8">
          <button type="button" className="btn-plain" onClick={() => void logout()}>
            Sign out
          </button>
        </p>
      )}
    </div>
  )
}
