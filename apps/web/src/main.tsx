// The entry point: read the environment, assemble the providers, mount.
//
// The environment is read here and only here — from then on it travels down
// as a dependency. If it is missing, the console does not mount at all and
// says what exactly is missing: a blank page with an error in the browser
// console is the costliest way to learn that a variable was forgotten in the
// hosting panel.
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ConsoleProviders } from './auth/providers'
import { readWebEnv, WebEnvError } from './env'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

const root = createRoot(rootElement)

try {
  const env = readWebEnv(import.meta.env)
  root.render(
    // The v7 flags are enabled explicitly: otherwise the router prints warnings
    // to the console. `basename` is `base` from vite.config.ts: on GitHub Pages
    // the console lives under `/<repo>/`, and without it no route would match
    // the address.
    <BrowserRouter
      basename={import.meta.env.BASE_URL}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <ConsoleProviders env={env}>
        <App />
      </ConsoleProviders>
    </BrowserRouter>,
  )
} catch (error) {
  if (!(error instanceof WebEnvError)) throw error
  root.render(
    <div className="mx-auto max-w-[560px] px-5 py-24">
      <h1 className="section-head block">This build is misconfigured</h1>
      <ul className="mt-5">
        {error.problems.map((problem) => (
          <li key={problem} className="mono12 border-b border-hairline py-2">
            {problem}
          </li>
        ))}
      </ul>
      <p className="muted mt-5 text-[12px] leading-relaxed">
        These come from build-time variables and are baked into the bundle, so fixing them means
        building again — see <span className="num">.env.example</span>.
      </p>
    </div>,
  )
}
