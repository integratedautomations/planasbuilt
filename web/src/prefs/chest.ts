// Tool chest layout the user chose: group order, item order inside groups, and per-group display options.

export type ChestView = 'list' | 'grid'
export type ChestSize = 'small' | 'medium' | 'large'

export interface GroupPrefs {
  /** Whether the group starts open (default true). */
  expanded?: boolean
  view?: ChestView
  size?: ChestSize
  hidden?: boolean
}

export interface ChestPrefs {
  /** Group names in the saved order (groups not listed keep their default place after these). */
  groupOrder: string[]
  /** Entry ids per group name in the saved order. */
  itemOrder: Record<string, string[]>
  groups: Record<string, GroupPrefs>
}

export const DEFAULT_CHEST: ChestPrefs = { groupOrder: [], itemOrder: {}, groups: {} }

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Accepts anything (older versions, hand-edited, null) and returns a well-formed ChestPrefs. */
export function normalizeChest(raw: unknown): ChestPrefs {
  const r = isObj(raw) ? raw : {}
  const itemOrder: Record<string, string[]> = {}
  if (isObj(r.itemOrder)) for (const [k, v] of Object.entries(r.itemOrder)) if (strings(v)) itemOrder[k] = v
  const groups: Record<string, GroupPrefs> = {}
  if (isObj(r.groups)) for (const [k, v] of Object.entries(r.groups)) {
    if (!isObj(v)) continue
    const g: GroupPrefs = {}
    if (typeof v.expanded === 'boolean') g.expanded = v.expanded
    if (v.view === 'list' || v.view === 'grid') g.view = v.view
    if (v.size === 'small' || v.size === 'medium' || v.size === 'large') g.size = v.size
    if (typeof v.hidden === 'boolean') g.hidden = v.hidden
    groups[k] = g
  }
  return { groupOrder: strings(r.groupOrder) ? r.groupOrder : [], itemOrder, groups }
}

/** Items sorted by the saved key order; anything not saved keeps its original relative order after the saved ones. */
export function orderBy<T>(items: T[], key: (t: T) => string, saved: string[] | undefined): T[] {
  if (!saved?.length) return items
  const rank = new Map(saved.map((k, i) => [k, i]))
  const known = items.filter(i => rank.has(key(i))).sort((a, b) => rank.get(key(a))! - rank.get(key(b))!)
  return [...known, ...items.filter(i => !rank.has(key(i)))]
}

/** New full order after moving `id` so it sits before `before` (null = last). `current` is the order on screen now. */
export function moveBefore(current: string[], id: string, before: string | null): string[] {
  if (id === before || !current.includes(id)) return current
  const rest = current.filter(x => x !== id)
  const at = before === null ? rest.length : rest.indexOf(before)
  if (at < 0) return current
  rest.splice(at, 0, id)
  return rest
}

export function groupPrefs(c: ChestPrefs, name: string): Required<GroupPrefs> {
  const g = c.groups[name] ?? {}
  return { expanded: g.expanded ?? true, view: g.view ?? 'list', size: g.size ?? 'medium', hidden: g.hidden ?? false }
}

export function setGroup(c: ChestPrefs, name: string, patch: GroupPrefs): ChestPrefs {
  return { ...c, groups: { ...c.groups, [name]: { ...c.groups[name], ...patch } } }
}

export function moveGroup(c: ChestPrefs, shownNames: string[], name: string, before: string | null): ChestPrefs {
  return { ...c, groupOrder: moveBefore(shownNames, name, before) }
}

export function moveItem(c: ChestPrefs, group: string, shownIds: string[], id: string, before: string | null): ChestPrefs {
  return { ...c, itemOrder: { ...c.itemOrder, [group]: moveBefore(shownIds, id, before) } }
}

export function showAllGroups(c: ChestPrefs): ChestPrefs {
  return { ...c, groups: Object.fromEntries(Object.entries(c.groups).map(([k, g]) => [k, { ...g, hidden: false }])) }
}

/** Forget the custom group and item order (display options stay). */
export function resetChestOrder(c: ChestPrefs): ChestPrefs {
  return { ...c, groupOrder: [], itemOrder: {} }
}

export const hiddenGroupCount = (c: ChestPrefs) => Object.values(c.groups).filter(g => g.hidden).length

/** Pixel size of an entry icon for a size setting. */
export const ICON_PX: Record<ChestSize, number> = { small: 16, medium: 22, large: 32 }
