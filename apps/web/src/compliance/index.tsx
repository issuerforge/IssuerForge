// The officer's screens as the registry mounts them: with the real, Privy-
// backed submitter. Loaded as a separate chunk, like the wizard — the screen
// registry must stay readable without a signing library (`console/screens.tsx`).
import ActionsScreen from './ActionsScreen'
import ProposalScreen from './ProposalScreen'
import { PrivySubmitter } from './privy-submitter'

export function ComplianceActions() {
  return (
    <PrivySubmitter>
      <ActionsScreen />
    </PrivySubmitter>
  )
}

export function ComplianceProposal() {
  return (
    <PrivySubmitter>
      <ProposalScreen />
    </PrivySubmitter>
  )
}
