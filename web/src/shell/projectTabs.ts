/** The project tab strip: every tab is a real route under /projects/:id. Pure, so the routes are testable without a DOM. */
export interface ProjectTab { id: 'plans' | 'devices' | 'wiring' | 'bom' | 'members' | 'settings'; label: string; to: string; end: boolean }

export function projectTabs(projectId: string, o: { canManage: boolean; platformAdmin?: boolean; canSeeCosts?: boolean }): ProjectTab[] {
  const base = `/projects/${projectId}`
  const tabs: ProjectTab[] = [
    { id: 'plans', label: 'Plans', to: base, end: true },
    { id: 'devices', label: 'Devices', to: `${base}/devices`, end: false },
    { id: 'wiring', label: 'Wiring', to: `${base}/wiring`, end: false },
    { id: 'bom', label: o.canSeeCosts === false ? 'Parts' : 'BOM', to: `${base}/bom`, end: false },
    { id: 'members', label: 'Members', to: `${base}/members`, end: false },
  ]
  if (o.canManage || o.platformAdmin) tabs.push({ id: 'settings', label: 'Settings', to: `${base}/settings`, end: false })
  return tabs
}

/** Project sub-pages that are tabs. Anything else under /projects/:id (the viewer) is not wrapped by the shell. */
export const PROJECT_TAB_IDS = ['devices', 'wiring', 'bom', 'members', 'settings'] as const

/** Old and moved routes -> where they live now. Returns null when the path is not a legacy one. */
export function legacyRedirect(pathname: string, search = ''): string | null {
  const p = pathname.replace(/\/+$/, '') || '/'
  const q = new URLSearchParams(search)
  if (p === '/preferences') return '/account/preferences'
  if (p === '/settings') {
    const tab = q.get('tab')
    switch (tab) {
      case 'company': case 'organization': return '/company/profile'
      case 'storage': return '/company/storage'
      case 'email': return '/company/email'
      default: return '/account/profile'
    }
  }
  if (p === '/users') return '/company/members'
  if (p === '/catalog' || p === '/symbols') return '/company/catalog'
  if (p === '/backups') return '/company/backups'
  if (p === '/companies') return '/platform/companies'
  return null
}
