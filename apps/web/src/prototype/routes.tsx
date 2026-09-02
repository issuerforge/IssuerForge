// M0-прототип: екрани на вигаданих числах, живі тільки як форма продукту.
//
// Живуть під `/prototype/*` і входу не вимагають — це демонстрація форми, а не
// екран емітента. Кожне число тут вигадане, і футер кожного екрана це каже вголос.
//
// Зникають зі своїми задачами: майстер — у T023, екран офіцера — у T034.
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
