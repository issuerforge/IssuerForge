// Стан майстра: чернетка, крок і жива симуляція правил.
//
// **Симуляція живе тут, а не на екрані Review.** FR-004 вимагає показати
// наслідки правил **до** підпису, і корисно це рівно тоді, коли людина ще може
// передумати: вердикти стоять поруч із самими правилами й переписуються на
// кожній зміні. Ручка `POST /api/policy/simulate` у мережу не ходить і ролей не
// питає (T021), тож ціна виклику — один запит.
//
// **Крок живе в адресі, а не в стані компонента.** Інакше кнопка «назад» у
// браузері викидала б людину з форми, заповненої наполовину. Параметром запиту,
// а не шляхом: реєстр екранів (T010) зіставляє шляхи точно, і `/issue/limits`
// довелося б заводити туди окремим рядком із власною роллю.
import { simulatePolicyResponseSchema } from '@forge/api/contracts'
import { useQuery } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '@/auth/providers'
import { type Draft, EMPTY_DRAFT, LAST_STEP, parsedPolicy } from './draft.ts'

/**
 * Скільки чекати після останнього натискання клавіші.
 *
 * Триста мілісекунд — це пауза між словами, а не між літерами: симуляція на
 * кожен символ давала б блимання вердиктів там, де людина ще друкує число.
 */
export const SIMULATE_DEBOUNCE_MS = 300

interface WizardValue {
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  step: number
  goTo: (step: number) => void
  /** Найдальший крок, якого дійшли: рейка не пускає вперед по недосягнутому. */
  reached: number
  simulation: ReturnType<typeof useSimulation>
}

const WizardContext = createContext<WizardValue | null>(null)

export function useWizard(): WizardValue {
  const ctx = useContext(WizardContext)
  if (!ctx) throw new Error('useWizard must be used inside WizardProvider')
  return ctx
}

/**
 * Симуляція чинної чернетки.
 *
 * Гонка відповідей гаситься не таймером, а ключем кеша: `react-query` показує
 * дані того запиту, чий ключ чинний **зараз**, тож відповідь, яка приїхала
 * після наступної правки, не має куди потрапити на екран.
 *
 * Політика, яка ще не збирається (порожні поля, ліміт нулем), запиту не робить
 * узагалі: показувати вердикти для правил, яких немає, означало б показувати
 * наслідки чогось іншого.
 */
function useSimulation(draft: Draft) {
  const api = useApi()
  const policy = useMemo(() => parsedPolicy(draft), [draft])
  const [settled, setSettled] = useState(policy)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(policy), SIMULATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [policy])

  const key = settled === undefined ? null : JSON.stringify(settled)

  return useQuery({
    queryKey: ['policy-simulate', key],
    enabled: key !== null,
    // Одна й та сама політика дає один і той самий вердикт, і рахує його чиста
    // функція на сервері: повертатись на крок назад і назад уперед не має
    // коштувати запиту.
    staleTime: 5 * 60_000,
    queryFn: () =>
      api.post('/api/policy/simulate', { policy: settled }, simulatePolicyResponseSchema),
  })
}

export function WizardProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [params, setParams] = useSearchParams()
  const [reached, setReached] = useState(1)

  const raw = Number(params.get('step') ?? '1')
  const step = Number.isInteger(raw) && raw >= 1 && raw <= LAST_STEP ? raw : 1

  useEffect(() => {
    setReached((previous) => (step > previous ? step : previous))
  }, [step])

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }))
  }, [])

  const goTo = useCallback(
    (next: number) => {
      // `replace: false` — кроки лишаються в історії браузера, і «назад» веде на
      // попередній крок, а не з майстра геть.
      setParams({ step: String(next) })
      window.scrollTo(0, 0)
    },
    [setParams],
  )

  const simulation = useSimulation(draft)

  const value = useMemo<WizardValue>(
    () => ({ draft, set, step, goTo, reached, simulation }),
    [draft, set, step, goTo, reached, simulation],
  )

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>
}
