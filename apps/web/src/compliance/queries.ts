// The officer's reads. Each goes to the api, and the api goes to the chain:
// none of these numbers come from the mirror (`apps/api/src/compliance.ts`).
import {
  proposalDetailResponseSchema,
  proposalListResponseSchema,
} from '@forge/api/contracts/actions'
import { complianceSummarySchema, tokenListResponseSchema } from '@forge/api/contracts/compliance'
import { useQuery } from '@tanstack/react-query'
import { useApi, useTenant } from '@/auth/providers'

/**
 * The issuer is part of every key: switching the tenant must not show the
 * previous issuer's proposals while the new ones load.
 */
const key = (issuerId: string | undefined, ...rest: string[]) =>
  ['compliance', issuerId ?? null, ...rest] as const

export function useTokens() {
  const api = useApi()
  const { issuerId } = useTenant()
  return useQuery({
    queryKey: key(issuerId, 'tokens'),
    queryFn: () => api.get('/api/tokens', tokenListResponseSchema),
  })
}

export function useSummary(mint: string | undefined) {
  const api = useApi()
  const { issuerId } = useTenant()
  return useQuery({
    queryKey: key(issuerId, 'summary', mint ?? ''),
    queryFn: () => api.get(`/api/tokens/${mint}/compliance`, complianceSummarySchema),
    enabled: mint !== undefined,
  })
}

export function useProposals(mint: string | undefined) {
  const api = useApi()
  const { issuerId } = useTenant()
  return useQuery({
    queryKey: key(issuerId, 'proposals', mint ?? ''),
    queryFn: () => api.get(`/api/tokens/${mint}/actions`, proposalListResponseSchema),
    enabled: mint !== undefined,
  })
}

export function useProposal(id: string) {
  const api = useApi()
  const { issuerId } = useTenant()
  return useQuery({
    queryKey: key(issuerId, 'proposal', id),
    queryFn: () => api.get(`/api/actions/${id}`, proposalDetailResponseSchema),
  })
}
