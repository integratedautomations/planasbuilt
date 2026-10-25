// Pure logic behind the header's company switcher.
import { setActiveCompanyId } from './activeCompany'
import type { CompanyRole } from '../roles'

export interface CompanyRow {
  id: string; name: string; slug?: string; archived: boolean; created_at?: string
  role: CompanyRole | null; member: boolean; can_create_projects?: boolean; active?: boolean; member_count?: number
  /** An invitation for this user that they have not answered yet (absent on older servers). */
  pending?: boolean
}

/** Invitations waiting for an answer. */
export const pendingInvitations = (companies: CompanyRow[]): CompanyRow[] =>
  companies.filter(c => c.pending === true && !c.archived)

/** Platform admins see every company, so the switcher is useful to them even with one membership. */
export function showSwitcher(user: { platform_admin?: boolean } | null | undefined, companies: CompanyRow[]): boolean {
  if (!user) return false
  if (user.platform_admin) return true
  return companies.filter(c => c.member && !c.archived && !c.pending).length > 1
}

/** Companies offered in the switcher: members' companies, plus every active one for platform admins. */
export function switchable(user: { platform_admin?: boolean } | null | undefined, companies: CompanyRow[]): CompanyRow[] {
  const rows = companies.filter(c => !c.archived && !c.pending && (c.member || user?.platform_admin))
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Which company to start in: the one remembered on this device if the user may still use it, else the server's
 * choice (/api/me), else the first they belong to.
 */
export function pickInitialCompany(stored: string | null, serverActive: string | null, usable: string[]): string | null {
  if (stored && usable.includes(stored)) return stored
  if (serverActive && usable.includes(serverActive)) return serverActive
  return usable[0] ?? null
}

/** Pages that show one company's data: after a switch they go back to the project list. */
export function pageBelongsToCompany(pathname: string): boolean {
  return /^\/(projects|users|backups|company\/(members|backups))(\/|$)/.test(pathname)
}
export function pathAfterSwitch(pathname: string): string {
  return pageBelongsToCompany(pathname) && pathname !== '/' ? '/' : pathname
}

/** Remember the company the server says this user is working in (so headers, URLs and the cache follow it). */
export function adoptCompany(user: { company?: { id: string } | null }) {
  setActiveCompanyId(user.company?.id ?? null)
}
