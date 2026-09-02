import { type ReactNode, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { usePolicy } from './policy'
import Rulebook from './Rulebook'
import StepRail, { STEPS } from './StepRail'

type Props = {
  step: number
  title: string
  children: ReactNode
  footer?: ReactNode
}

export function Masthead() {
  return (
    <header className="border-b border-hairline">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-baseline justify-between gap-2 px-5 py-4">
        <span className="smallcaps">IssuerForge · policy for issuance</span>
        <span className="mono12 muted">Vantara Pay · Lagos, Nigeria</span>
      </div>
    </header>
  )
}

export default function WizardLayout({ step, title, children, footer }: Props) {
  const { visit } = usePolicy()

  useEffect(() => {
    visit(step)
    window.scrollTo(0, 0)
  }, [step, visit])

  const back = STEPS.find((s) => s.n === step - 1)

  return (
    <div className="min-h-screen">
      <Masthead />
      <StepRail current={step} />

      <main className="mx-auto max-w-[1180px] px-5">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <section className="py-8 lg:pr-10">
            <div className="flex items-baseline justify-between border-b border-hairline pb-2">
              <h1 className="smallcaps">
                <span className="num mr-2">{step}</span>
                {title}
              </h1>
              <span className="mono12 muted">step {step} of 5</span>
            </div>
            <div className="mt-6">{children}</div>

            {footer && (
              <div className="mt-10 flex flex-wrap items-center gap-5 border-t border-hairline pt-5">
                {footer}
                {back && (
                  <Link to={back.path} className="btn-plain muted">
                    Back to {back.n} {back.label.toLowerCase()}
                  </Link>
                )}
              </div>
            )}
          </section>

          <section className="border-t border-hairline py-8 lg:border-l lg:border-t-0 lg:pl-10">
            <Rulebook />
          </section>
        </div>
      </main>

      <footer className="mt-6 border-t border-hairline">
        <div className="mx-auto max-w-[1180px] px-5 py-4">
          <p className="mono12 muted">
            Prototype · all figures, names and addresses shown are fictional
          </p>
        </div>
      </footer>
    </div>
  )
}
