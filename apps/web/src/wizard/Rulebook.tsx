// Збірник правил: політика словами плюс те, що вона зробить.
//
// Дві половини одного питання. Верхня — речення, які людина підпише
// (`clauses.ts`); нижня — вердикти симуляції на п'яти сценаріях FR-004, тобто
// та сама політика, прогнана оцінювачем. Разом вони й дають «показати наслідки
// правил до підпису»: текст без наслідків читається як намір, наслідки без
// тексту — як магія.
import type { SimulatePolicyResponse } from '@forge/api/contracts'
import { buildClauses } from './clauses.ts'
import { useWizard } from './WizardContext.tsx'

/** Людські назви сценаріїв каталогу. Порядок — той, у якому їх шле сервер. */
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
                Незастосовний сценарій лишається видимим рядком, а не зникає.
                Чотири рядки замість п'яти прочитались би як «усе гаразд», хоча
                означали б «цього правила в політиці немає» (рішення T021).
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
        // Це не «завантаження»: політика ще не зібралася, тобто симулювати нема
        // чого. Сказати треба саме це, інакше порожнє місце читається як «нічого
        // не станеться».
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
