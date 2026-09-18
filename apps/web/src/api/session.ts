// The session in the console is a read, not a computation.
//
// The server derives the role from the issuer's membership by wallet
// addresses (FR-034a), and the console has neither the data nor the right to
// derive it itself. Here there is only the request, a check of the response
// against the schema from `@forge/shared/api`, and the cache key.
import { type Session, sessionSchema } from '@forge/shared/api'
import { usePrivy } from '@privy-io/react-auth'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { useApi, useTenant } from '@/auth/providers'

/**
 * The chosen issuer is part of the cache key: switching the tenant is a
 * different session with a different role mask, and the previous one must not
 * be shown while the new one is loading.
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
    // Before login completes the request makes no sense: there is no token
    // yet, and the client would answer `UNAUTHORIZED` on every render while
    // Privy comes up.
    enabled: ready && authenticated,
  })
}
