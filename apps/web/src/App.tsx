import { Route, Routes } from 'react-router-dom'
import { PolicyProvider } from '@/lib/policy'
import ConsoleCase from './pages/ConsoleCase'
import ConsoleToken from './pages/ConsoleToken'
import NotFound from './pages/NotFound'
import Step1Token from './pages/Step1Token'
import Step2Holders from './pages/Step2Holders'
import Step3Limits from './pages/Step3Limits'
import Step4Powers from './pages/Step4Powers'
import Step5Review from './pages/Step5Review'

const App = () => (
  <PolicyProvider>
    <Routes>
      <Route path="/" element={<Step1Token />} />
      <Route path="/who-may-hold" element={<Step2Holders />} />
      <Route path="/limits" element={<Step3Limits />} />
      <Route path="/powers" element={<Step4Powers />} />
      <Route path="/review" element={<Step5Review />} />
      <Route path="/console" element={<ConsoleToken />} />
      <Route path="/console/case/REG-2026-0412" element={<ConsoleCase />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </PolicyProvider>
)

export default App
