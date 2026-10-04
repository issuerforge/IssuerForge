// The delegation screen as the registry mounts it: with the real, Privy-backed
// submitter, in its own chunk (`console/screens.tsx`).
import { PrivySubmitter } from '@/compliance/privy-submitter'
import DelegationScreen from './delegation'

export function Delegation() {
  return (
    <PrivySubmitter>
      <DelegationScreen />
    </PrivySubmitter>
  )
}
