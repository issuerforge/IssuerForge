// The console routes.
//
// The list of screens is not repeated here: it comes from the registry
// (`console/screens.tsx`), and every entry is wrapped in the same role guard.
// Adding a screen is a line in the registry, not an edit in three places.
import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireScreen, RequireSession, useConsoleSession } from '@/auth/guards'
import ConsoleLayout from '@/console/ConsoleLayout'
import { landingFor, SCREENS } from '@/console/screens'
import NotFound from '@/pages/NotFound'
import Notice from '@/pages/Notice'
import PrototypeRoutes from '@/prototype/routes'

/**
 * The root leads to the first screen available to this role.
 *
 * An empty result is impossible for a valid session — `/console` is open to
 * any role, and the session mask is never empty — but assuming so would cost
 * a blank screen, so the case is named.
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
