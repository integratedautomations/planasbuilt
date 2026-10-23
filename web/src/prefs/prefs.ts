// Per-user preferences: shape, defaults and the merge used when this device and the server disagree.
import { DEFAULT_LAYOUT, normalizeLayout } from './layout'
import type { LayoutPrefs } from './layout'
import { DEFAULT_CHEST, normalizeChest } from './chest'
import type { ChestPrefs } from './chest'
import { isReplaceChoice } from '../markups/placeReplace'
import type { ReplaceChoice } from '../markups/placeReplace'
import { isDensityPref } from './density'
import type { DensityPref } from './density'
import { isThemePref } from './theme'
import type { ThemePref } from './theme'
import { DEFAULT_SNAP, normalizeSnap } from '../markups/snapConfig'
import type { SnapSettings } from '../markups/snapConfig'

export interface Prefs {
  /** Only the combos the user changed ('' = unassigned); see hotkeys.resolveHotkeys. */
  hotkeys: Record<string, string>
  layout: LayoutPrefs
  /** Tool chest entry ids ("tool:rect", "set:<id>") in the user's order. */
  favorites: string[]
  /** Most recent first, at most RECENT_MAX. */
  recent: string[]
  /** Which fields the markup popup shows ("tag", "type", "status", "area", "placedBy", "field:<key>"). */
  popupFields: string[]
  /** Markups list columns to show (ids from listColumns); null = all. */
  listColumns: string[] | null
  /** Tool chest layout: group/item order and per-group display options. */
  chest: ChestPrefs
  /** Last choices in the as-built report options dialog (see pdfio/reportOptions). */
  reportOptions: Record<string, unknown>
  /** Last choices in the print dialog (see pdfio/printPlan). */
  printOptions: Record<string, unknown>
  /** Placing a device on a device of another type: ask, replace it, or place both. */
  replaceOnOverlap: ReplaceChoice
  /** Keep the Properties panel open even when nothing is selected. */
  propsPinned: boolean
  /** Button/row sizes: auto (by pointer), compact or comfortable. */
  density: DensityPref
  /** Color scheme: follow the device or force light / dark. */
  theme: ThemePref
  /** Snapping: master switch, per-source toggles, align-to-walls and the grid. */
  snap: SnapSettings
}

export type PrefKey = keyof Prefs
export const PREF_KEYS: PrefKey[] = ['hotkeys', 'layout', 'favorites', 'recent', 'popupFields', 'listColumns', 'chest', 'reportOptions', 'printOptions', 'replaceOnOverlap', 'propsPinned', 'density', 'theme', 'snap']

export const RECENT_MAX = 10
export const DEFAULT_POPUP_FIELDS = ['tag', 'type', 'status', 'area']

export const DEFAULT_PREFS: Prefs = {
  hotkeys: {},
  layout: DEFAULT_LAYOUT,
  favorites: ['tool:select', 'tool:rect', 'tool:line', 'tool:text'],
  recent: [],
  popupFields: DEFAULT_POPUP_FIELDS,
  listColumns: null,
  chest: DEFAULT_CHEST,
  reportOptions: {},
  printOptions: {},
  replaceOnOverlap: 'ask',
  propsPinned: false,
  density: 'auto',
  theme: 'auto',
  snap: DEFAULT_SNAP,
}

/** What is stored locally and on the server: the values the user set, each stamped with when (ms since epoch). */
export interface StoredPrefs {
  data: Partial<Prefs>
  stamps: Partial<Record<PrefKey, number>>
}

export const EMPTY_STORED: StoredPrefs = { data: {}, stamps: {} }

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** Accepts anything (old versions, hand-edited, null) and returns a well-formed StoredPrefs. */
export function sanitizeStored(raw: unknown): StoredPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredPrefs>
  const d = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>
  const data: Partial<Prefs> = {}
  const stamps: Partial<Record<PrefKey, number>> = {}
  const keep = <K extends PrefKey>(k: K, v: Prefs[K]) => {
    data[k] = v
    const t = (r.stamps as Record<string, unknown> | undefined)?.[k]
    stamps[k] = typeof t === 'number' && isFinite(t) ? t : 0
  }
  if (d.hotkeys && typeof d.hotkeys === 'object' && !Array.isArray(d.hotkeys))
    keep('hotkeys', Object.fromEntries(Object.entries(d.hotkeys).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
  if (d.layout && typeof d.layout === 'object') keep('layout', normalizeLayout(d.layout))
  if (strings(d.favorites)) keep('favorites', d.favorites)
  if (strings(d.recent)) keep('recent', d.recent.slice(0, RECENT_MAX))
  if (strings(d.popupFields)) keep('popupFields', d.popupFields)
  if (d.listColumns === null || strings(d.listColumns)) keep('listColumns', d.listColumns as string[] | null)
  if (d.chest && typeof d.chest === 'object') keep('chest', normalizeChest(d.chest))
  for (const k of ['reportOptions', 'printOptions'] as const)
    if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) keep(k, d[k] as Record<string, unknown>)
  if (isReplaceChoice(d.replaceOnOverlap)) keep('replaceOnOverlap', d.replaceOnOverlap)
  if (typeof d.propsPinned === 'boolean') keep('propsPinned', d.propsPinned)
  if (isDensityPref(d.density)) keep('density', d.density)
  if (isThemePref(d.theme)) keep('theme', d.theme)
  if (d.snap && typeof d.snap === 'object' && !Array.isArray(d.snap)) keep('snap', normalizeSnap(d.snap))
  return { data, stamps }
}

/**
 * Merges this device's prefs with the server's, one setting at a time: the newer stamp wins (a tie keeps the local value).
 * `pushNeeded` says some setting is newer here (or missing on the server) so the merged result should be saved back.
 */
export function mergePrefs(local: StoredPrefs, remote: StoredPrefs): { merged: StoredPrefs; pushNeeded: boolean; changed: boolean } {
  const merged: StoredPrefs = { data: {}, stamps: {} }
  let pushNeeded = false, changed = false
  for (const k of PREF_KEYS) {
    const inLocal = k in local.data, inRemote = k in remote.data
    if (!inLocal && !inRemote) continue
    const lt = local.stamps[k] ?? 0, rt = remote.stamps[k] ?? 0
    const useRemote = inRemote && (!inLocal || rt > lt)
    const src = useRemote ? remote : local
    ;(merged.data as Record<string, unknown>)[k] = src.data[k]
    merged.stamps[k] = src.stamps[k] ?? 0
    if (useRemote) changed = true
    else if (!inRemote || lt > rt) pushNeeded = true
  }
  return { merged, pushNeeded, changed }
}

/** The effective prefs: defaults overlaid with whatever was stored. */
export function effectivePrefs(stored: StoredPrefs): Prefs {
  return { ...DEFAULT_PREFS, ...stored.data } as Prefs
}

/** Puts a tool entry first in the recent list (deduplicated, capped). */
export function pushRecent(recent: string[], id: string): string[] {
  return [id, ...recent.filter(x => x !== id)].slice(0, RECENT_MAX)
}

/** Adds/removes a favorite; adding appends to the end. */
export function toggleFavorite(favs: string[], id: string): string[] {
  return favs.includes(id) ? favs.filter(x => x !== id) : [...favs, id]
}

/** Moves a favorite so it sits where `before` currently is (or last when before is null). */
export function reorderFavorites(favs: string[], id: string, before: string | null): string[] {
  if (id === before || !favs.includes(id)) return favs
  const rest = favs.filter(x => x !== id)
  const at = before === null ? rest.length : rest.indexOf(before)
  if (at < 0) return favs
  rest.splice(at, 0, id)
  return rest
}
