// Маршрути консолі.
//
// Список екранів тут не повторюється: він приходить із реєстру
// (`console/screens.tsx`), і кожен пункт обгортається тим самим ґардом ролі.
// Додати екран — це рядок у реєстрі, а не правка в трьох місцях.
import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireScreen, RequireSession, useConsoleSession } from '@/auth/guards'
import ConsoleLayout from '@/console/ConsoleLayout'
import { landingFor, SCREENS } from '@/console/screens'
import NotFound from '@/pages/NotFound'
import Notice from '@/pages/Notice'
import PrototypeRoutes from '@/prototype/routes'

/**
 * Корінь веде на перший екран, доступний цій ролі.
 *
 * Порожній результат неможливий для дійсної сесії — `/console` відкритий
 * будь-якій ролі, а маска сесії ніколи не порожня, — але припущення про це
 * коштувало б білого екрана, тож випадок названий.
 */
function Landing() {
  const session = useConsoleSession()
  const first = landingFor(session.roles)

  if (!first) {
    return (
      <Notice
        title="Your role opens no screen"
        body="You stand in this issuer’s roster, but the roles held there open nothing in this console. An administrator of the issuer can change that."
        signOut
      />
    )
  }
  return <Navigate to={first.path} replace />
}

const App = () => (
  <Routes>
    <Route element={<RequireSession />}>
      <Route path="/" element={<Landing />} />
      <Route element={<ConsoleLayout />}>
        {SCREENS.map((screen) => (
          <Route
            key={screen.path}
            path={screen.path}
            element={<RequireScreen screen={screen}>{screen.element}</RequireScreen>}
          />
        ))}
      </Route>
    </Route>

    <Route path="/prototype/*" element={<PrototypeRoutes />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
)

export default App
