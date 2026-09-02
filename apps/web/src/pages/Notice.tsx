// Одноекранне повідомлення: очікування, відмова, збій.
//
// Один компонент на всі три, бо вони відрізняються тільки текстом, а не формою.
// `requestId` показується завжди, коли він є: за ним рядок лога api знаходиться
// однозначно, і це єдине, що варто переказати по телефону.
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
