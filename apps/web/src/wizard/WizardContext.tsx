// The wizard state: the draft, the step and the live rule simulation.
//
// **The simulation lives here, not on the Review screen.** FR-004 requires
// showing the consequences of the rules **before** signing, and that is
// useful exactly while the person can still change their mind: the verdicts
// stand next to the rules themselves and are rewritten on every change. The
// `POST /api/policy/simulate` handler goes neither to the network nor asks
// for a role (T021), so the cost of a call is one request.
//
// **The step lives in the address, not in component state.** Otherwise the
// browser's back button would throw the person out of a half-filled form. A
// query parameter, not a path: the screen registry (T010) matches paths
// exactly, and `/issue/limits` would have to be added there as a separate
// line with its own role.
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
 * How long to wait after the last keystroke.
 *
 * Three hundred milliseconds is the pause between words, not between
 * letters: a simulation on every character would give flickering verdicts
 * while the person is still typing a number.
 */
export const SIMULATE_DEBOUNCE_MS = 300

interface WizardValue {
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  step: number
  goTo: (step: number) => void
  /** The furthest step reached: the rail does not let you jump ahead past the unreached. */
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
 * The simulation of the current draft.
 *
 * The response race is settled not by a timer but by the cache key:
 * `react-query` shows the data of the request whose key is current **now**,
 * so a response that arrived after the next edit has nowhere to land on the
 * screen.
 *
 * A policy that does not come together yet (empty fields, a limit of zero)
 * makes no request at all: showing verdicts for rules that do not exist
 * would mean showing the consequences of something else.
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
    // The same policy gives the same verdict, and a pure function on the
    // server computes it: going a step back and forward again must not cost a
    // request.
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
      // `replace: false` — the steps stay in the browser history, and "back"
      // leads to the previous step, not out of the wizard.
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
