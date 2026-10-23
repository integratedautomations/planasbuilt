// Project roles and what each may do. The web app mirrors this table in web/src/roles.ts - keep them in step.
//
// Roles, most to least access: admin, pm, editor, field, sub, client, viewer.
//  - admin:  everything, including members and deleting plans and layers.
//  - pm:     editor + costs and labor; cannot manage members.
//  - editor: draws and edits; sees costs only while the project setting "editors see costs" is on (default on).
//  - field:  device fields, status, notes, photos (and comments); cannot create, move, resize or delete markups, nor change plans.
//  - sub:    field rights, limited to the symbol sets and layers in project_members.scope (empty = nothing).
//  - client: read-only, no costs, no fields flagged internal.
//  - viewer: read-only (sees what it always saw, costs included).

export const ROLES = ['admin', 'pm', 'editor', 'field', 'sub', 'client', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const CAPS = [
  'view', 'comment', 'markup.fields', 'photos.edit', 'markup.create', 'markup.geometry', 'markup.delete',
  'plans.edit', 'plans.delete', 'costs.view', 'members.manage', 'internal.view',
] as const
export type Cap = (typeof CAPS)[number]

const ALL: readonly Cap[] = CAPS
const EDITOR_CAPS: readonly Cap[] = [
  'view', 'comment', 'markup.fields', 'photos.edit', 'markup.create', 'markup.geometry', 'markup.delete', 'plans.edit', 'internal.view',
]
const FIELD_CAPS: readonly Cap[] = ['view', 'comment', 'markup.fields', 'photos.edit', 'internal.view']

/** Capabilities that do not depend on a project setting. `costs.view` for editors is decided by `can`. */
const TABLE: Record<Role, readonly Cap[]> = {
  admin: ALL,
  pm: [...EDITOR_CAPS, 'costs.view'],
  editor: EDITOR_CAPS,
  field: FIELD_CAPS,
  sub: FIELD_CAPS,
  client: ['view', 'comment'],
  viewer: ['view', 'costs.view', 'internal.view'],
}

export interface CapOptions {
  /** The project's "editors see costs" setting (default on, so existing projects behave as before). */
  editorsSeeCosts?: boolean
}

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)

export function can(role: Role | null | undefined, cap: Cap, opts: CapOptions = {}): boolean {
  if (!role) return false
  if (cap === 'costs.view' && role === 'editor') return opts.editorsSeeCosts !== false
  return TABLE[role].includes(cap)
}

/** The symbol sets and layers a `sub` may see and work on. Empty lists mean nothing. */
export interface Scope { sets: string[]; layers: string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function normalizeScope(v: unknown): Scope {
  const ids = (x: unknown) => [...new Set((Array.isArray(x) ? x : []).filter((s): s is string => typeof s === 'string' && UUID.test(s)).map(s => s.toLowerCase()))]
  const o = v && typeof v === 'object' ? (v as any) : {}
  return { sets: ids(o.sets), layers: ids(o.layers) }
}

/** Who someone is in one project. */
export interface Access { role: Role; scope: Scope; editorsSeeCosts: boolean; /** The project is locked: only admins may change anything. */ locked?: boolean }

/** Capabilities that change data; a locked project allows them to admins only. */
export const WRITE_CAPS: ReadonlySet<Cap> = new Set<Cap>([
  'markup.fields', 'photos.edit', 'markup.create', 'markup.geometry', 'markup.delete', 'plans.edit', 'plans.delete',
])

export const accessCan = (a: Access | null | undefined, cap: Cap) =>
  !!a && can(a.role, cap, { editorsSeeCosts: a.editorsSeeCosts }) && !(a.locked && a.role !== 'admin' && WRITE_CAPS.has(cap))

/** A sub's markup is in scope when its symbol set or its layer is listed. */
export function inScope(scope: Scope, m: { symbol_set_id?: string | null; layer_id?: string | null }): boolean {
  const set = m.symbol_set_id?.toLowerCase(), layer = m.layer_id?.toLowerCase()
  return (!!set && scope.sets.includes(set)) || (!!layer && scope.layers.includes(layer))
}

/** False only for a sub looking at a markup outside their scope. */
export const canSeeMarkup = (a: Pick<Access, 'role' | 'scope'>, m: { symbol_set_id?: string | null; layer_id?: string | null }) =>
  a.role !== 'sub' || inScope(a.scope, m)

export const filterMarkups = <T extends { symbol_set_id?: string | null; layer_id?: string | null }>(a: Pick<Access, 'role' | 'scope'>, list: T[]): T[] =>
  a.role === 'sub' ? list.filter(m => inScope(a.scope, m)) : list

/** Cost and labor fields removed from a product row (accessories included). */
export function stripProductCosts<T extends Record<string, any>>(p: T): T {
  const { unit_cost: _c, labor_hours: _l, ...rest } = p as Record<string, any>
  if (Array.isArray(rest.accessories))
    rest.accessories = rest.accessories.map((a: any) => {
      if (!a || typeof a !== 'object') return a
      const { unit_cost: _ac, labor_hours: _al, ...r } = a
      return r
    })
  return rest as T
}

/** Removes fields flagged `internal` from a field-definition list (what clients may not see). */
export const publicFieldDefs = <T extends { internal?: boolean }>(defs: T[]): T[] => defs.filter(d => !d?.internal)

/** Removes the values of internal fields from a markup's `fields`, given the definitions that may flag them. */
export function stripInternalValues<T extends { fields?: Record<string, any> }>(m: T, internalKeys: Set<string>): T {
  if (!internalKeys.size || !m.fields) return m
  const f: Record<string, any> = {}
  for (const [k, v] of Object.entries(m.fields)) if (!internalKeys.has(k)) f[k] = v
  return { ...m, fields: f }
}
