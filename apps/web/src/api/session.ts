// Сесія в консолі — читання, а не обчислення.
//
// Роль виводить сервер зі складу емітента за адресами гаманців (FR-034a), і
// консоль не має ані даних, ані права вивести її сама. Тут лише запит,
// перевірка відповіді схемою з `@forge/shared/api` і ключ кешу.
import { type Session, sessionSchema } from '@forge/shared/api'
import { usePrivy } from '@privy-io/react-auth'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { useApi, useTenant } from '@/auth/providers'

/**
 * Обраний емітент входить у ключ кешу: перемикання орендаря — це інша сесія з
 * іншою маскою ролей, і показувати попередню, поки їде нова, не можна.
 */
export const sessionQueryKey = (issuerId: string | undefined) =>
  ['session', issuerId ?? null] as const

export function useSession(): UseQueryResult<Session, Error> {
  const api = useApi()
  const { issuerId } = useTenant()
  const { ready, authenticated } = usePrivy()

  return useQuery({
    queryKey: sessionQueryKey(issuerId),
    queryFn: () => api.get('/api/session', sessionSchema),
    // До завершення входу запит не має сенсу: токена ще немає, і клієнт
    // відповів би `UNAUTHORIZED` на кожен рендер, поки Privy піднімається.
    enabled: ready && authenticated,
  })
}
