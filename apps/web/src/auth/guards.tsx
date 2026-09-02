// Ґарди маршрутів: вхід, орендар, роль.
//
// Стану «екран намалювався без сесії» не існує — так само, як його немає на
// боці api (`requireSession` там або ставить сесію в контекст, або не пускає
// далі). Компоненти нижче або показують сесію, або показують, чого бракує.
import type { Session } from '@forge/shared/api'
import { usePrivy } from '@privy-io/react-auth'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { ApiRequestError } from '@/api/client'
import { useSession } from '@/api/session'
import { permits, type Screen } from '@/console/screens'
import Forbidden from '@/pages/Forbidden'
import Notice from '@/pages/Notice'
import PickIssuer from '@/pages/PickIssuer'
import SignIn from '@/pages/SignIn'
import { useTenant } from './providers'
import { resolveTenant } from './tenant'

const SessionContext = createContext<Session | null>(null)

/**
 * Скільки чекати на постачальника входу, перш ніж сказати, що він не відповів.
 *
 * Це не про повільну мережу: `ready` не стає істинним ніколи, якщо
 * `VITE_PRIVY_APP_ID` синтаксично правильний, але такого застосунку немає —
 * а це рівно та помилка розгортання, якої `readWebEnv` не бачить. Без межі
 * консоль вічно показує «відкриваємо», і причина лишається в мережевій панелі.
 */
const READY_TIMEOUT_MS = 10_000

function useReadyTimedOut(ready: boolean): boolean {
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    if (ready) return
    const timer = setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [ready])

  return timedOut && !ready
}

/** Сесія всередині ґарда. Поза ним викликати нема звідки — і не можна. */
export function useConsoleSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useConsoleSession must be used inside RequireSession')
  return session
}

/**
 * Перелік емітентів, який api назвав у `details.issuerIds`, коли заголовок не
 * обраний або називає емітента поза складом.
 *
 * Окремої ручки «мої емітенти» немає навмисно: сервер уже сказав, серед чого
 * вибирати, і другий запит за тим самим переліком був би другим джерелом
 * правди про членства.
 */
function offeredIssuers(error: unknown): string[] | undefined {
  if (!(error instanceof ApiRequestError) || error.code !== 'INVALID_INPUT') return undefined
  const offered = error.details?.issuerIds
  if (!Array.isArray(offered)) return undefined
  const ids = offered.filter((id): id is string => typeof id === 'string')
  return ids.length > 0 ? ids : undefined
}

export function RequireSession() {
  const { ready, authenticated } = usePrivy()
  const { issuerId, select } = useTenant()
  const session = useSession()
  const [dropped, setDropped] = useState<string | undefined>(undefined)
  const loginUnreachable = useReadyTimedOut(ready)

  // Склад емітентів, відомий цій відповіді: або з успішної сесії, або з
  // переліку, який api назвав у відмові. Обидва джерела — той самий сервер.
  const known = session.data?.memberships.map((m) => m.issuerId) ?? offeredIssuers(session.error)
  // Рядком, а не масивом: новий масив на кожен рендер зациклив би ефект.
  const knownKey = known?.join(',')

  useEffect(() => {
    if (knownKey === undefined) return
    const resolved = resolveTenant(knownKey === '' ? [] : knownKey.split(','), issuerId)
    // Роль відкликають кворумом, і збережений вибір це переживає. Сказати про
    // це треба один раз і вголос: інакше людина бачить перелік емітентів без
    // жодного пояснення, чому її викинуло з того, що було відкрите вчора.
    if (resolved.dropped !== undefined) setDropped(resolved.dropped)
    if (resolved.issuerId !== issuerId) select(resolved.issuerId)
  }, [knownKey, issuerId, select])

  if (!ready) {
    return loginUnreachable ? (
      <Notice
        title="The login provider did not answer"
        body="The console could not reach Privy. Either this build carries an app id that no longer exists, or the provider is unreachable from here. Both are deployment problems, not something signing in again can fix."
      />
    ) : (
      <Notice title="Opening the console" />
    )
  }
  if (!authenticated) return <SignIn />
  if (session.isPending) return <Notice title="Reading your role" />

  if (session.error) {
    const issuerIds = offeredIssuers(session.error)
    if (issuerIds) {
      return (
        <PickIssuer
          issuerIds={issuerIds}
          dropped={dropped}
          onPick={(picked) => {
            setDropped(undefined)
            select(picked)
          }}
        />
      )
    }

    const problem = session.error instanceof ApiRequestError ? session.error : undefined

    // `UNAUTHORIZED` тут означає не «токен поганий», а «ця адреса не стоїть у
    // складі жодного емітента»: токен уже перевірений, інакше входу не було б.
    // Пропозиція увійти ще раз була б порадою, яка нічого не змінює.
    if (problem?.code === 'UNAUTHORIZED') {
      return (
        <Notice
          title="No issuer lists this wallet"
          body="Access to a console follows the wallet address that stands in an issuer’s roster, not the account you signed in with. Ask an administrator of that issuer to add this address."
          requestId={problem.requestId}
          signOut
        />
      )
    }

    return (
      <Notice
        title="The console could not read your role"
        body={problem?.message ?? 'Unexpected failure.'}
        requestId={problem?.requestId}
        signOut
      />
    )
  }

  return (
    <SessionContext.Provider value={session.data}>
      <Outlet />
    </SessionContext.Provider>
  )
}

/** Роль не відкриває екран — кажемо це, а не показуємо 404 і не редіректимо. */
export function RequireScreen({ screen, children }: { screen: Screen; children: ReactNode }) {
  const session = useConsoleSession()
  if (!permits(session.roles, screen)) return <Forbidden screen={screen} roles={session.roles} />
  return <>{children}</>
}
