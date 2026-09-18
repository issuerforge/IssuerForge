// The wizard shell: the step rail, the form area, the live rulebook beside
// it.
//
// Two columns are not cosmetics: FR-004 requires showing the consequences of
// the rules **before** signing, and that is useful exactly when the rule and
// the consequence are visible at the same time. On the last step the columns
// merge — there the rulebook reads as a document, not as a hint.
import { problemsAt, STEPS } from './draft.ts'
import Review from './Review.tsx'
import Rulebook from './Rulebook.tsx'
import { Step1Token, Step2Holders, Step3Limits, Step4Reserve } from './steps.tsx'
import { useWizard, WizardProvider } from './WizardContext.tsx'

function StepRail() {
  const { step, reached, goTo } = useWizard()

  return (
    <nav className="border-b border-hairline">
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3 sm:gap-x-7">
        {STEPS.map((entry, index) => {
          const current = entry.n === step
          // The rail does not let you jump ahead past the unreached: step 4
          // without step 1 is a form with half the fields empty and a grey
          // button with no explanation.
          const open = entry.n <= reached
          return (
            <li key={entry.n} className="flex items-center gap-x-5 sm:gap-x-7">
              <button
                type="button"
                disabled={!open}
                onClick={() => goTo(entry.n)}
                className="smallcaps inline-block pb-[3px]"
                style={{
                  color: open ? 'var(--ink)' : 'var(--ink-muted)',
                  borderBottom: current ? '2px solid var(--ink)' : '2px solid transparent',
                }}
              >
                <span className="num mr-2">{entry.n}</span>
                {entry.label}
              </button>
              {index < STEPS.length - 1 && (
                <span className="muted hidden text-[11px] sm:inline">·</span>
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

const BODY = [Step1Token, Step2Holders, Step3Limits, Step4Reserve] as const

function Body() {
  const { draft, step, goTo } = useWizard()

  if (step === STEPS.length) return <Review />

  const Current = BODY[step - 1] ?? Step1Token
  const problems = problemsAt(step, draft)
  const next = STEPS[step]

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2">
      <section className="py-8 lg:pr-10">
        <div className="flex items-baseline justify-between border-b border-hairline pb-2">
          <h1 className="smallcaps">
            <span className="num mr-2">{step}</span>
            {STEPS[step - 1]?.label}
          </h1>
          <span className="mono12 muted">
            step {step} of {STEPS.length}
          </span>
        </div>

        <div className="mt-6">
          <Current />
        </div>

        {/*
          A list, not a grey button: the person must be told what is missing. A
          button that silently will not click is a riddle, not a check.
        */}
        {problems.length > 0 && (
          <ul className="mt-8 border-t border-hairline pt-3">
            {problems.map((problem) => (
              <li key={problem} className="muted py-1 text-[12px]">
                {problem}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-5 border-t border-hairline pt-5">
          <button
            type="button"
            className="btn-primary"
            disabled={problems.length > 0}
            onClick={() => goTo(step + 1)}
          >
            Continue to {next?.n} {next?.label.toLowerCase()}
          </button>
          {step > 1 && (
            <button type="button" className="btn-plain muted" onClick={() => goTo(step - 1)}>
              Back to {step - 1} {STEPS[step - 2]?.label.toLowerCase()}
            </button>
          )}
        </div>
      </section>

      <section className="border-t border-hairline py-8 lg:border-l lg:border-t-0 lg:pl-10">
        <Rulebook />
      </section>
    </div>
  )
}

export default function Wizard() {
  return (
    <WizardProvider>
      <StepRail />
      <Body />
    </WizardProvider>
  )
}
