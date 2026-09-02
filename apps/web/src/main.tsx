// Точка входу: прочитати оточення, зібрати провайдери, змонтувати.
//
// Оточення читається тут і тільки тут — далі воно їде вниз як залежність. Якщо
// його бракує, консоль не монтується взагалі й каже, чого саме бракує: біла
// сторінка з помилкою в консолі браузера — найдорожчий спосіб дізнатись, що в
// панелі хостингу забули змінну.
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
    // Прапорці v7 увімкнені явно: інакше router друкує попередження в консоль.
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
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
