// Project roles and what each may do. Mirrors server/src/roles.ts - keep the two tables in step (the server is the authority;
// this copy only decides what the UI offers).
//
// Roles, most to least access: admin, pm, editor, field, sub, client, viewer.

export const ROLES = ['admin', 'pm', 'editor', 'field', 'sub', 'client', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const CAPS = [
  'view', 'comment', 'markup.fields', 'photos.edit', 'markup.create', 'markup.geometry', 'markup.delete',
  'plans.edit', 'plans.delete', 'costs.view', 'members.manage', 'internal.view',
] as const
export type Cap = (typeof CAPS)[number]

const EDITOR_CAPS: readonly Cap[] = [
  'view', 'comment', 'markup.fields', 'photos.edit', 'markup.create', 'markup.geometry', 'markup.delete', 'plans.edit', 'internal.view',
]
const FIELD_CAPS: readonly Cap[] = ['view', 'comment', 'markup.fields', 'photos.edit', 'internal.view']

const TABLE: Record<Role, readonly Cap[]> = {
  admin: CAPS,
  pm: [...EDITOR_CAPS, 'costs.view'],
  editor: EDITOR_CAPS,
  field: FIELD_CAPS,
  sub: FIELD_CAPS,
  client: ['view', 'comment'],
  viewer: ['view', 'costs.view', 'internal.view'],
}

export interface CapOptions {
  /** The project's "editors see costs" setting (default on). */
  editorsSeeCosts?: boolean
}

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)

export function can(role: Role | null | undefined, cap: Cap, opts: CapOptions = {}): boolean {
  if (!role) return false
  if (cap === 'costs.view' && role === 'editor') return opts.editorsSeeCosts !== false
  return TABLE[role].includes(cap)
}

/** The symbol sets and layers a `sub` works on. Empty lists mean nothing. */
export interface Scope { sets: string[]; layers: string[] }
export const EMPTY_SCOPE: Scope = { sets: [], layers: [] }

/** True for roles that change fields/status/notes/photos but never geometry (field and sub). */
export const isFieldOnly = (role: Role | null | undefined) => can(role, 'markup.fields') && !can(role, 'markup.geometry')

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  admin: { label: 'Admin', description: 'Everything, including members, deleting plans and layers, and project settings.' },
  pm: { label: 'Project manager', description: 'Edits like an editor and always sees costs and labor hours. Cannot manage members.' },
  editor: { label: 'Editor', description: 'Draws and edits plans and devices. Sees costs unless the project hides them from editors.' },
  field: { label: 'Field tech', description: 'Updates device fields, status, notes and photos. Cannot add, move, resize or delete markups or change plans.' },
  sub: { label: 'Subcontractor', description: 'Like a field tech, but only for the symbol sets and layers chosen below. Sees nothing else.' },
  client: { label: 'Client', description: 'Read-only. No costs and no fields marked internal.' },
  viewer: { label: 'Viewer', description: 'Read-only.' },
}

// ---- Company roles (a person's standing in one company; mirrors server/src/roles.ts) ----
// owner / admin manage the company; member can be added to projects; guest only sees projects they are invited to.

export const COMPANY_ROLES = ['owner', 'admin', 'member', 'guest'] as const
export type CompanyRole = (typeof COMPANY_ROLES)[number]

export const isCompanyRole = (v: unknown): v is CompanyRole => typeof v === 'string' && (COMPANY_ROLES as readonly string[]).includes(v)

export const COMPANY_ROLE_INFO: Record<CompanyRole, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything in the company, including who else is an owner.' },
  admin: { label: 'Admin', description: 'Manages the company catalog, settings, members, storage and backups. Sees every project.' },
  member: { label: 'Member', description: 'Can be added to projects, and can create projects when allowed.' },
  guest: { label: 'Guest', description: 'Only sees projects they are invited to, and the catalog without costs.' },
}

const COMPANY_RANK: Record<CompanyRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 }

/** True when `role` is at least `min`. */
export function companyRoleAtLeast(role: CompanyRole | null | undefined, min: CompanyRole): boolean {
  return !!role && COMPANY_RANK[role] >= COMPANY_RANK[min]
}
/** Owners and admins manage the company. */
export const isCompanyAdmin = (role: CompanyRole | null | undefined) => companyRoleAtLeast(role, 'admin')
/** May this person create projects? Company admins always; members when granted; guests never. */
export function canCreateProjectsIn(role: CompanyRole | null | undefined, granted: boolean | undefined): boolean {
  if (!role || role === 'guest') return false
  return isCompanyAdmin(role) || !!granted
}
