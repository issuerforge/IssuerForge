// The M0 prototype: screens on invented numbers, alive only as the shape of
// the product.
//
// They live under `/prototype/*` and require no login — they are a demo of the
// product's shape, not an issuer's screen. Every number here is invented, and
// the footer of every screen says so out loud.
//
// They disappear with their tasks: the wizard in T023, the officer's screen
// in T034.
import { Route, Routes } from 'react-router-dom'
import ConsoleCase from './ConsoleCase'
import ConsoleToken from './ConsoleToken'
import { PolicyProvider } from './policy'
import Step1Token from './Step1Token'
import Step2Holders from './Step2Holders'
import Step3Limits from './Step3Limits'
import Step4Powers from './Step4Powers'
import Step5Review from './Step5Review'

export default function PrototypeRoutes() {
  return (
    <PolicyProvider>
      <Routes>
        <Route index element={<Step1Token />} />
        <Route path="who-may-hold" element={<Step2Holders />} />
        <Route path="limits" element={<Step3Limits />} />
        <Route path="powers" element={<Step4Powers />} />
        <Route path="review" element={<Step5Review />} />
        <Route path="console" element={<ConsoleToken />} />
        <Route path="console/case/REG-2026-0412" element={<ConsoleCase />} />
      </Routes>
    </PolicyProvider>
  )
}
