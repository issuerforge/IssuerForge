// The rulebook: the policy in words plus what it will do.
//
// Two halves of one question. The upper one is the sentences the person will
// sign (`clauses.ts`); the lower one is the simulation verdicts on the five
// FR-004 scenarios, i.e. the same policy run through the evaluator. Together
// they deliver "show the consequences of the rules before signing": text
// without consequences reads as intent, consequences without text as magic.
import type { SimulatePolicyResponse } from '@forge/api/contracts'
import { buildClauses } from './clauses.ts'
import { useWizard } from './WizardContext.tsx'

/** Human names of the catalogue scenarios. The order is the one the server sends them in. */
const SCENARIO_LABEL: Record<string, string> = {
  verified: 'A verified holder sends exactly the limit',
  unverified: 'An unverified account receives',
  'over-limit': 'A verified holder sends one unit over the limit',
  denied: 'An account this issuer denied receives',
  paused: 'Any transfer while the token is paused',
}

function Verdicts({ data }: { data: SimulatePolicyResponse }) {
  return (
    <ul className="mt-3">
      {data.scenarios.map((scenario) => {
        const refused = !scenario.verdict.allowed
        return (
          <li
            key={scenario.name}
            className="grid grid-cols-1 items-baseline gap-x-4 gap-y-1 border-b border-hairline py-2 md:grid-cols-[1fr_5rem_11rem]"
            style={{ color: refused ? 'var(--refuse)' : 'var(--ink)' }}
          >
            <span className="text-[13px]">
              {SCENARIO_LABEL[scenario.name] ?? scenario.name}
              {/*
                An inapplicable scenario stays a visible line rather than vanishing.
                Four lines instead of five would read as "all fine", while they
                would mean "this rule is not in the policy" (decision T021).
              */}
              {!scenario.applicable && (
                <span className="muted"> — no such rule in this policy</span>
              )}
            </span>
            <span className="text-[13px] md:text-right">{refused ? 'refused' : 'allowed'}</span>
            <span className="mono12 md:text-right">
              {scenario.verdict.allowed ? '' : scenario.verdict.code}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export default function Rulebook({ documentMode = false }: { documentMode?: boolean }) {
  const { draft, step, goTo, simulation } = useWizard()
  const clauses = buildClauses(draft)

  return (
    <div>
      <h2 className="section-head block">The policy, in words</h2>
      <ol className="mt-3">
        {clauses.map((clause) => {
          const current = clause.step === step
          return (
            <li
              key={clause.id}
              className="grid grid-cols-[2.6rem_1fr] items-baseline border-b border-hairline py-2"
              style={{ color: current && !documentMode ? 'var(--ink)' : 'var(--ink-muted)' }}
            >
              <button
                type="button"
                className="mono12 text-left"
                onClick={() => goTo(clause.step)}
                title={`Edit in step ${clause.step}`}
              >
                {clause.id}
              </button>
              <span className="text-[13px] leading-relaxed">{clause.text}</span>
            </li>
          )
        })}
      </ol>

      <h2 className="section-head mt-9 block">What these rules will do</h2>
      {simulation.isError && (
        <p className="muted mt-3 text-[12px]">
          The api could not simulate this policy: {String(simulation.error?.message ?? '')}
        </p>
      )}
      {!simulation.isError && simulation.data === undefined && (
        // This is not "loading": the policy has not come together yet, so there
        // is nothing to simulate. That is exactly what must be said, otherwise
        // the empty space reads as "nothing will happen".
        <p className="muted mt-3 text-[12px]">
          {simulation.isFetching
            ? 'Simulating…'
            : 'The rules are not complete enough to simulate yet.'}
        </p>
      )}
      {simulation.data !== undefined && <Verdicts data={simulation.data} />}
      {simulation.data !== undefined && (
        <p className="muted mt-3 text-[12px] leading-relaxed">
          Simulated by the same rule model the token itself runs. The network is the authority; this
          is the answer it would give.
        </p>
      )}
    </div>
  )
}
