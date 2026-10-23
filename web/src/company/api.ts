import { api } from '../api'
import type { CompanyRole } from '../roles'
import type { CompanyRow } from './switcher'

export type { CompanyRow }

export interface CompanyMember {
  user_id: string; id: string; email: string; name: string; status: 'active' | 'invited' | 'deactivated'
  last_seen_at: string | null; platform_admin: boolean; role: CompanyRole; can_create_projects: boolean; joined_at: string
}

/** Summary of moving a project to another company. */
export interface MoveResult {
  ok: boolean
  symbol_sets?: { matched: number; copied: number }
  device_types?: { matched: number; copied: number }
  products?: { matched: number; copied: number }
  cable_types?: { matched: number; copied: number }
  members_added?: number
}

export const listCompanies = (opts: { mine?: boolean; includeArchived?: boolean } = {}) => {
  const q = [opts.mine ? 'mine=1' : '', opts.includeArchived ? 'include_archived=1' : ''].filter(Boolean).join('&')
  return api<CompanyRow[]>('/companies' + (q ? `?${q}` : ''))
}
export const createCompany = (body: { name: string; owner_email?: string; seed_catalog?: boolean }) =>
  api<CompanyRow>('/companies', { method: 'POST', body: JSON.stringify(body) })
export const patchCompany = (id: string, body: { name?: string; archived?: boolean }) =>
  api<CompanyRow>(`/companies/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
export const listMembers = (id: string) => api<CompanyMember[]>(`/companies/${id}/members`)
export const putMember = (id: string, body: { email?: string; user_id?: string; role?: CompanyRole; can_create_projects?: boolean }) =>
  api<unknown>(`/companies/${id}/members`, { method: 'PUT', body: JSON.stringify(body) })
export const patchMember = (id: string, userId: string, body: { role?: CompanyRole; can_create_projects?: boolean }) =>
  api<unknown>(`/companies/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify(body) })
export const removeMember = (id: string, userId: string) =>
  api<unknown>(`/companies/${id}/members/${userId}`, { method: 'DELETE' })
export const moveProject = (projectId: string, companyId: string) =>
  api<MoveResult>(`/projects/${projectId}/move`, { method: 'POST', body: JSON.stringify({ company_id: companyId }) })

/** One line per catalog kind: "3 symbol sets matched, 1 copied". */
export function describeMove(r: MoveResult): string[] {
  const kinds: [keyof MoveResult, string][] = [['symbol_sets', 'symbol sets'], ['device_types', 'device types'], ['products', 'products'], ['cable_types', 'cable types']]
  const lines: string[] = []
  for (const [k, label] of kinds) {
    const v = r[k] as { matched: number; copied: number } | undefined
    if (v) lines.push(`${v.matched} ${label} matched, ${v.copied} copied`)
  }
  if (typeof r.members_added === 'number') lines.push(`${r.members_added} member${r.members_added === 1 ? '' : 's'} added to the new company`)
  return lines
}

/** Invitations for an existing account to join a company (the person must accept). `id` is the invitation id. */
export interface CompanyInvitation { id: string; company: { id: string; name: string }; role: string; projects: number; invited_by: string | null; created_at: string }
export const listInvitations = () => api<CompanyInvitation[]>('/company-invitations')
export const acceptInvitation = (id: string) => api<unknown>(`/company-invitations/${id}/accept`, { method: 'POST' })
export const declineInvitation = (id: string) => api<unknown>(`/company-invitations/${id}/decline`, { method: 'POST' })
