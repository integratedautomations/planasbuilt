import { entryInitials } from './toolEntries'
import type { ToolEntry } from './toolEntries'

/** One selectable chest on phones: a pinned list (Favorites, Recent), a tool group (Shapes, Measure, ...) or a symbol set. */
export interface ChestOption { id: string; label: string; entries: ToolEntry[] }

export const FAVORITES_CHEST = 'favorites'
export const RECENT_CHEST = 'recent'
const HIDDEN_GROUPS = ['Select / Navigate']

/** Chest choices in display order: Favorites, Recent, the fixed tool groups, then one per symbol set. Empty chests are left out. */
export function chestOptions(entries: ToolEntry[], favorites: string[], recent: string[], readOnly = false): ChestOption[] {
  if (readOnly) return []
  const byId = new Map(entries.map(e => [e.id, e]))
  const pick = (ids: string[]) => ids.map(id => byId.get(id)).filter((e): e is ToolEntry => !!e && !HIDDEN_GROUPS.includes(e.group))
  const out: ChestOption[] = [
    { id: FAVORITES_CHEST, label: 'Favorites', entries: pick(favorites) },
    { id: RECENT_CHEST, label: 'Recent', entries: pick(recent) },
  ]
  const seen = new Set<string>()
  for (const e of entries) {
    if (HIDDEN_GROUPS.includes(e.group)) continue
    const id = e.setId ? `set:${e.setId}` : `group:${e.group}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: e.group, entries: entries.filter(x => (x.setId ? `set:${x.setId}` : `group:${x.group}`) === id) })
  }
  return out.filter(o => o.entries.length > 0)
}

/** The chest to show: the saved one when it still exists, else the first symbol set, else the first chest. */
export function resolveChest(options: ChestOption[], saved: string | null | undefined): ChestOption | null {
  return options.find(o => o.id === saved) ?? options.find(o => o.id.startsWith('set:')) ?? options[0] ?? null
}

/** The chest an entry belongs to (its symbol set or tool group), so the row follows a tool picked elsewhere (the Device button, a hotkey). */
export function chestOfEntry(options: ChestOption[], entryId: string | null | undefined): ChestOption | null {
  if (!entryId) return null
  return options.find(o => o.id !== FAVORITES_CHEST && o.id !== RECENT_CHEST && o.entries.some(e => e.id === entryId)) ?? null
}

/** Short chip text: a device type's initials, else the first letters of the tool's name. */
export function chipLabel(e: ToolEntry): string {
  return e.initials || entryInitials(e.label)
}

const key = (projectId: string) => `pab.chest.${projectId}`

/** Last chest used in a project (browser-local; null when none or storage is blocked). */
export function loadChest(projectId: string): string | null {
  try { return localStorage.getItem(key(projectId)) } catch { return null }
}
export function saveChest(projectId: string, id: string): void {
  try { localStorage.setItem(key(projectId), id) } catch { /* private mode: not remembered */ }
}
