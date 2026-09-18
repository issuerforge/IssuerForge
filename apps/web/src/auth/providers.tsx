// The console providers: login, the query cache, the chosen tenant, the api
// client.
//
// The nesting order is not arbitrary. The api client takes the token from
// Privy and the chosen issuer from the switcher, so it must be inside both.
// The query cache sits above the client because it outlives its recreation.
//
// None of this reads the environment itself: `WebEnv` comes from above
// (`main.tsx`), the way dependencies come into `createServer(deps)` on the
// api side.
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type ApiClient, ApiRequestError, createApiClient } from '@/api/client'
import type { WebEnv } from '@/env'
import { readStoredTenant, writeStoredTenant } from './tenant'

/**
 * The query cache.
 *
 * `retry: false` on api errors is deliberate: `UNAUTHORIZED` and
 * `INVALID_INPUT` do not change on a retry, and three identical refusals in
 * the network panel hide the one that explains the cause. Only what looks
 * like a dropped connection is retried.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          error instanceof ApiRequestError && error.code === 'INTERNAL' && failureCount < 2,
        // The role membership is changed by quorum, and a revoked role must
        // vanish from the screen in the same request: the session is not
        // cached between window focuses.
        staleTime: 0,
        refetchOnWindowFocus: true,
      },
    },
  })
}

interface TenantValue {
  /** The chosen issuer, or `undefined` until a choice is made. */
  issuerId: string | undefined
  select: (issuerId: string | undefined) => void
}

const TenantContext = createContext<TenantValue | null>(null)
const ApiContext = createContext<ApiClient | null>(null)
const EnvContext = createContext<WebEnv | null>(null)

/**
 * The environment as a dependency, not as the global `import.meta.env`.
 *
 * `main.tsx` reads it — once, with one pure function — and the screens take
 * the ready value from here. There is no second place in the console where
 * the node address is decided (T023: the wizard sends transactions itself).
 */
export function useWebEnv(): WebEnv {
  const ctx = useContext(EnvContext)
  if (!ctx) throw new Error('useWebEnv must be used inside ConsoleProviders')
  return ctx
}

export function useTenant(): TenantValue {
  const ctx = useContext(TenantContext)
  if (!ctx) throw new Error('useTenant must be used inside ConsoleProviders')
  return ctx
}

export function useApi(): ApiClient {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error('useApi must be used inside ConsoleProviders')
  return ctx
}

function ApiAndTenant({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  const { getAccessToken } = usePrivy()
  const [issuerId, setIssuerId] = useState<string | undefined>(
    () => readStoredTenant() ?? undefined,
  )

  // The client reads the issuer through a ref, not through a closure over
  // state: otherwise every tenant switch would create a new client, and with
  // it a new key for every query, and the cache would reset where one refetch
  // is enough.
  const current = useRef(issuerId)
  current.current = issuerId

  const select = useCallback((next: string | undefined) => {
    setIssuerId(next)
    writeStoredTenant(next)
  }, [])

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: apiUrl,
        getAccessToken,
        issuerId: () => current.current,
      }),
    [apiUrl, getAccessToken],
  )

  const tenant = useMemo<TenantValue>(() => ({ issuerId, select }), [issuerId, select])

  return (
    <TenantContext.Provider value={tenant}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </TenantContext.Provider>
  )
}

export function ConsoleProviders({ env, children }: { env: WebEnv; children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  return (
    <PrivyProvider
      appId={env.VITE_PRIVY_APP_ID}
      config={{
        // Solana only: the project has no action on another chain, and a list
        // of wallets that will sign nothing is an invitation to pick the wrong
        // one.
        appearance: {
          theme: 'light',
          accentColor: '#15181c',
          walletChainType: 'solana-only',
          landingHeader: 'IssuerForge',
          loginMessage: 'Sign in to the issuer console',
        },
        // Email plus an external wallet — both paths from FR-034: an officer
        // without crypto gets an embedded key, an admin brings their own.
        loginMethods: ['email', 'wallet'],
        embeddedWallets: {
          // `users-without-wallets`: whoever logged in with an external wallet
          // already has the address they are in the membership under, and a
          // second key adds nothing to it.
          solana: { createOnLogin: 'users-without-wallets' },
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <EnvContext.Provider value={env}>
          <ApiAndTenant apiUrl={env.VITE_API_URL}>{children}</ApiAndTenant>
        </EnvContext.Provider>
      </QueryClientProvider>
    </PrivyProvider>
  )
}
