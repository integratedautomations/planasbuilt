import { markupBounds } from '../markups/selection'
import type { Rect } from '../markups/selection'
import type { Markup } from '../markups/types'

/** Center movement (page points) at or below this is not a move. */
export const MOVE_THRESHOLD = 2

export interface FieldChange { key: string; old: unknown; new: unknown }
export interface Pair { before: Markup; after: Markup }

export interface MarkupDiff {
  added: Markup[]
  removed: Markup[]
  moved: (Pair & { distance: number })[]
  resized: Pair[]
  fieldsChanged: (Pair & { changes: FieldChange[] })[]
  statusChanged: (Pair & { from: string; to: string })[]
  restyled: Pair[]
}

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as any)[k])).join(',') + '}'
  return JSON.stringify(v ?? null)
}

const center = (m: Markup) => { const b = markupBounds(m); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }

/** Size of a shape in its own frame (rotation and position ignored), so moving or turning never reads as resizing. */
function localSize(m: Markup): { w: number; h: number } {
  const g = m.geometry
  if ('points' in g) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i + 1 < g.points.length; i += 2) {
      x0 = Math.min(x0, g.points[i]); x1 = Math.max(x1, g.points[i]); y0 = Math.min(y0, g.points[i + 1]); y1 = Math.max(y1, g.points[i + 1])
    }
    return g.points.length < 2 ? { w: 0, h: 0 } : { w: x1 - x0, h: y1 - y0 }
  }
  return { w: Math.abs(g.width), h: Math.abs(g.height) }
}

/** Turned, or a path whose shape (not just position) differs. */
function reshaped(a: Markup, b: Markup): boolean {
  const ra = (a.geometry as any).rotation ?? 0, rb = (b.geometry as any).rotation ?? 0
  if (Math.abs(ra - rb) > 0.5) return true
  const ga = a.geometry, gb = b.geometry
  if ('points' in ga && 'points' in gb) {
    if (ga.points.length !== gb.points.length) return true
    return ga.points.some((v, i) => Math.abs(v - gb.points[i]) > 0.5)
  }
  return false
}

/** Compared like fields: these top-level columns describe the device, the rest live in `fields`. */
const DEVICE_KEYS = ['tag', 'text', 'symbol_set_id', 'device_type_id', 'product_id', 'layer_id'] as const

function fieldChanges(a: Markup, b: Markup): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of DEVICE_KEYS) {
    const x = (a as any)[k] ?? '', y = (b as any)[k] ?? ''
    if (x !== y) out.push({ key: k, old: x, new: y })
  }
  const fa = a.fields ?? {}, fb = b.fields ?? {}
  for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
    if (stable(fa[k]) !== stable(fb[k])) out.push({ key: `fields.${k}`, old: fa[k] ?? null, new: fb[k] ?? null })
  }
  return out
}

/** What changed from `a` (older) to `b` (newer), matching markups by id. One markup can appear in several lists. */
export function diffMarkups(a: Markup[], b: Markup[]): MarkupDiff {
  const out: MarkupDiff = { added: [], removed: [], moved: [], resized: [], fieldsChanged: [], statusChanged: [], restyled: [] }
  const before = new Map(a.map(m => [m.id, m]))
  const after = new Map(b.map(m => [m.id, m]))
  for (const m of a) if (!after.has(m.id)) out.removed.push(m)
  for (const m of b) {
    const old = before.get(m.id)
    if (!old) { out.added.push(m); continue }
    const pair = { before: old, after: m }
    const ca = center(old), cb = center(m)
    const distance = Math.hypot(cb.x - ca.x, cb.y - ca.y)
    const pageChanged = old.page !== m.page
    const sa = localSize(old), sb = localSize(m)
    const sizeChanged = Math.abs(sa.w - sb.w) > 0.5 || Math.abs(sa.h - sb.h) > 0.5
    const moved = pageChanged || distance > MOVE_THRESHOLD
    if (moved) out.moved.push({ ...pair, distance: pageChanged ? Infinity : distance })
    if (sizeChanged || reshaped(old, m)) out.resized.push(pair)
    const changes = fieldChanges(old, m)
    if (changes.length) out.fieldsChanged.push({ ...pair, changes })
    if ((old.status ?? '') !== (m.status ?? '')) out.statusChanged.push({ ...pair, from: old.status ?? '', to: m.status ?? '' })
    if (stable(old.style) !== stable(m.style)) out.restyled.push(pair)
  }
  return out
}

export type ChangeKind = 'added' | 'removed' | 'moved' | 'resized' | 'fields' | 'status' | 'style'

export interface ChangeEntry {
  id: string
  /** Page to look at: where the markup is now (or was, when removed). */
  page: number
  kinds: ChangeKind[]
  before: Markup | null
  after: Markup | null
  /** Bounds of the newer shape, or of the older one when it was removed. */
  rect: Rect
  /** Fields that changed, for the list's detail line. */
  changes: FieldChange[]
}

/** One entry per changed markup (a markup that moved and was restyled is one row with two kinds), ordered by page. */
export function changeEntries(diff: MarkupDiff): ChangeEntry[] {
  const byId = new Map<string, ChangeEntry>()
  const touch = (before: Markup | null, after: Markup | null, kind: ChangeKind, changes: FieldChange[] = []) => {
    const m = (after ?? before)!
    let e = byId.get(m.id)
    if (!e) {
      e = { id: m.id, page: m.page, kinds: [], before, after, rect: markupBounds(m), changes: [] }
      byId.set(m.id, e)
    }
    if (!e.kinds.includes(kind)) e.kinds.push(kind)
    e.changes.push(...changes)
  }
  for (const m of diff.added) touch(null, m, 'added')
  for (const m of diff.removed) touch(m, null, 'removed')
  for (const p of diff.moved) touch(p.before, p.after, 'moved')
  for (const p of diff.resized) touch(p.before, p.after, 'resized')
  for (const p of diff.fieldsChanged) touch(p.before, p.after, 'fields', p.changes)
  for (const p of diff.statusChanged) touch(p.before, p.after, 'status', [{ key: 'status', old: p.from, new: p.to }])
  for (const p of diff.restyled) touch(p.before, p.after, 'style')
  return [...byId.values()].sort((a, b) => a.page - b.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
}

export interface PageChanges { page: number; entries: ChangeEntry[]; counts: Record<ChangeKind, number> }

const emptyCounts = (): Record<ChangeKind, number> => ({ added: 0, removed: 0, moved: 0, resized: 0, fields: 0, status: 0, style: 0 })

/** Change list grouped by page, with a count per kind on each page. */
export function groupByPage(entries: ChangeEntry[]): PageChanges[] {
  const pages = new Map<number, PageChanges>()
  for (const e of entries) {
    let p = pages.get(e.page)
    if (!p) { p = { page: e.page, entries: [], counts: emptyCounts() }; pages.set(e.page, p) }
    p.entries.push(e)
    for (const k of e.kinds) p.counts[k]++
  }
  return [...pages.values()].sort((a, b) => a.page - b.page)
}

export const diffIsEmpty = (d: MarkupDiff) =>
  !d.added.length && !d.removed.length && !d.moved.length && !d.resized.length && !d.fieldsChanged.length && !d.statusChanged.length && !d.restyled.length

export const KIND_LABELS: Record<ChangeKind, string> = {
  added: 'Added', removed: 'Removed', moved: 'Moved', resized: 'Resized', fields: 'Fields', status: 'Status', style: 'Style',
}
