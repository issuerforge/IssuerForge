// Провайдери консолі: вхід, кеш запитів, обраний орендар, клієнт api.
//
// Порядок вкладення не довільний. Клієнт api бере токен у Privy й обраного
// емітента в перемикача, тож він мусить бути всередині обох. Кеш запитів стоїть
// вище за клієнт, бо переживає його перестворення.
//
// Нічого з цього не читає оточення саме: `WebEnv` приходить згори (`main.tsx`),
// як залежності приходять у `createServer(deps)` на боці api.
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
 * Кеш запитів.
 *
 * `retry: false` на помилках api навмисний: `UNAUTHORIZED` і `INVALID_INPUT`
 * від повтору не змінюються, а три однакові відмови в мережевій панелі
 * приховують ту одну, що пояснює причину. Повторюється тільки те, що схоже на
 * зрив зв'язку.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          error instanceof ApiRequestError && error.code === 'INTERNAL' && failureCount < 2,
        // Склад ролей змінюється кворумом, і відкликана роль має зникати з
        // екрана в тому ж запиті: сесія не кешується між фокусами вікна.
        staleTime: 0,
        refetchOnWindowFocus: true,
      },
    },
  })
}

interface TenantValue {
  /** Обраний емітент або `undefined`, поки вибір не зроблено. */
  issuerId: string | undefined
  select: (issuerId: string | undefined) => void
}

const TenantContext = createContext<TenantValue | null>(null)
const ApiContext = createContext<ApiClient | null>(null)
const EnvContext = createContext<WebEnv | null>(null)

/**
 * Оточення як залежність, а не як глобальний `import.meta.env`.
 *
 * Читає його `main.tsx` — один раз і однією чистою функцією, — а екрани беруть
 * готове значення звідси. Другого місця, де вирішується, що таке адреса вузла,
 * у консолі немає (T023: майстер відправляє транзакції сам).
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

  // Клієнт читає емітента через ref, а не через замикання на стані: інакше
  // кожне перемикання орендаря створювало б новий клієнт, а з ним — новий ключ
  // усіх запитів, і кеш скидався б там, де достатньо одного перезапиту.
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
        // Solana-only: у проєкті немає жодної дії в іншому ланцюзі, а список
        // гаманців, які нічого не підпишуть, — це запрошення обрати не той.
        appearance: {
          theme: 'light',
          accentColor: '#15181c',
          walletChainType: 'solana-only',
          landingHeader: 'IssuerForge',
          loginMessage: 'Sign in to the issuer console',
        },
        // Пошта плюс зовнішній гаманець — обидва шляхи з FR-034: офіцер без
        // крипти отримує вбудований ключ, адміністратор приносить свій.
        loginMethods: ['email', 'wallet'],
        embeddedWallets: {
          // `users-without-wallets`: той, хто зайшов зовнішнім гаманцем, уже має
          // адресу, під якою стоїть у складі, і другий ключ їй нічого не додає.
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
