// Cable runs locked to devices. A cable is a click path; when its first / last point sits on a device's centre the cable
// stores that device's markup id in geometry.from / geometry.to. Pure helpers: linking, following moves, dangling ends and
// length math. useMarkups.commit() runs syncCables() on every change, so a device that moves, is deleted or leaves the page
// carries its cable ends in the same undo step.
import type { CableType } from '../catalog/types'
import { deviceCenter, pathFromPoints } from './geometry'
import type { Pt } from './geometry'
import { formatFeetInches, polylineLength } from './measure'
import type { MeasureTotal } from './measure'
import { pathPoints } from './snap'
import type { Markup, PathGeometry, ViaLink } from './types'
import type { Change } from './useMarkups'

export type CableEnd = 'from' | 'to'
export const CABLE_ENDS: readonly CableEnd[] = ['from', 'to']

/** Field keys on a cable markup. */
export const CABLE_FIELD = { type: 'cable_type', count: 'cable_count', slack: 'cable_slack_pct', drop: 'cable_drop_ft' } as const

/** A cable end this close (page points) to a device centre counts as sitting on it. */
export const LINK_TOLERANCE = 0.25

/** `viaDrop`: also add the drop at devices the run passes through (default on). */
export interface CableSettings { slackPct: number; dropFt: number; viaDrop?: boolean }
export const DEFAULT_CABLE_SETTINGS: CableSettings = { slackPct: 10, dropFt: 0, viaDrop: true }

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

const pathOf = (m: Markup): PathGeometry | null => (m.type === 'cable' && m.geometry && 'points' in m.geometry ? m.geometry : null)
export const isCable = (m: Pick<Markup, 'type'>) => m.type === 'cable'

/** Project settings (from the API) as cable defaults; anything unusable falls back to 10 % and 0 ft. */
export function cableSettings(p?: { cable_slack_pct?: unknown; cable_drop_ft?: unknown; settings?: { cable_via_drop?: unknown } | null } | null): CableSettings {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return { slackPct: n(p?.cable_slack_pct, DEFAULT_CABLE_SETTINGS.slackPct), dropFt: n(p?.cable_drop_ft, DEFAULT_CABLE_SETTINGS.dropFt), viaDrop: p?.settings?.cable_via_drop !== false }
}

export function endPoint(g: PathGeometry, end: CableEnd): Pt | null {
  const pts = pathPoints(g)
  if (pts.length < 2) return null
  return end === 'from' ? pts[0] : pts[pts.length - 1]
}

/** Centre of a device markup, or null for anything else. */
export function deviceCentreOf(m: Markup | null | undefined): Pt | null {
  return m && m.type === 'device' && m.geometry && 'width' in m.geometry ? deviceCenter(m.geometry) : null
}

/** The device whose centre is nearest to `p` within `radius` (same page when given; `skip` ids are ignored). */
export function nearestDevice(devices: Iterable<Markup>, p: Pt, radius: number, o: { page?: number; skip?: ReadonlySet<string> } = {}): Markup | null {
  let best: Markup | null = null, bd = Infinity
  for (const m of devices) {
    if (m.type !== 'device' || (o.page !== undefined && m.page !== o.page) || o.skip?.has(m.id)) continue
    const c = deviceCentreOf(m)
    if (!c) continue
    const d = dist(c, p)
    if (d <= radius && d < bd) { best = m; bd = d }
  }
  return best
}

const keepLinks = (n: PathGeometry, g: PathGeometry): PathGeometry => ({
  ...n, ...(g.from ? { from: g.from } : {}), ...(g.to ? { to: g.to } : {}), ...(g.open?.length ? { open: g.open } : {}), ...(g.via?.length ? { via: g.via } : {}),
})

/** The cable with one end point moved to `p` (links kept). The geometry is re-anchored so the first point stays at the origin. */
export function setEnd(g: PathGeometry, end: CableEnd, p: Pt): PathGeometry {
  const abs = pathPoints(g)
  if (abs.length < 2) return g
  abs[end === 'from' ? 0 : abs.length - 1] = p
  return keepLinks(pathFromPoints(abs), g)
}

/** Sets (`id`) or clears (null) the link at one end; `open` marks / unmarks the dangling-end flag (omitted: a new link clears it, clearing leaves it). */
export function withLink(g: PathGeometry, end: CableEnd, id: string | null, open?: boolean): PathGeometry {
  const out: PathGeometry = { ...g }
  if (id) out[end] = id; else delete out[end]
  const flag = open ?? (id ? false : (g.open?.includes(end) ?? false))
  const set = new Set(g.open ?? [])
  if (flag) set.add(end); else set.delete(end)
  if (set.size) out.open = CABLE_ENDS.filter(e => set.has(e)); else delete out.open
  return out
}

/** Ends whose device is gone: flagged open (device deleted / left the page) or pointing at a markup that is not a device on this page. */
export function danglingEnds(m: Markup, byId: ReadonlyMap<string, Markup>): CableEnd[] {
  const g = pathOf(m)
  if (!g) return []
  const out: CableEnd[] = []
  for (const end of CABLE_ENDS) {
    const ref = g[end]
    if (g.open?.includes(end)) out.push(end)
    else if (ref) {
      const d = byId.get(ref)
      if (!d || d.type !== 'device' || d.page !== m.page || d.document_id !== m.document_id) out.push(end)
    }
  }
  return out
}

/** Ends locked to a device that exists on the same page. */
export function linkedEnds(m: Markup, byId: ReadonlyMap<string, Markup>): CableEnd[] {
  const g = pathOf(m)
  if (!g) return []
  return CABLE_ENDS.filter(end => {
    const d = g[end] ? byId.get(g[end]!) : undefined
    return !!d && d.type === 'device' && d.page === m.page && d.document_id === m.document_id
  })
}

/**
 * Links the first / last point of a freshly drawn or edited cable: an end sitting on a device centre locks to it, an end
 * that moved off its device unlinks, an end already flagged dangling keeps its marker. `all` holds the markups of the
 * cable's document.
 */
export function relinkEnds(g: PathGeometry, all: ReadonlyMap<string, Markup>, page: number, tol = LINK_TOLERANCE): PathGeometry {
  let out = g
  for (const end of CABLE_ENDS) {
    const p = endPoint(out, end)
    if (!p) continue
    const cur = out[end] ? all.get(out[end]!) : undefined
    const curC = cur && cur.type === 'device' && cur.page === page ? deviceCentreOf(cur) : null
    if (curC && dist(p, curC) <= tol) continue
    const hit = nearestDevice(all.values(), p, tol, { page })
    if (hit) { out = withLink(out, end, hit.id, false); continue }
    if (out[end] && curC) out = withLink(out, end, null)
  }
  return withVia(out, all, page, tol)
}

// ---- Devices a run passes through (daisy chain): geometry.via = [{ id, i }], i = index of the vertex that sits on the device
// centre. Only intermediate vertices (not the first / last point, which are the from / to ends) can be via points.

/** The via links of a cable, sorted by vertex. */
export const viaOf = (g: PathGeometry): ViaLink[] => (g.via ?? []).slice().sort((a, b) => a.i - b.i)

function setVia(g: PathGeometry, via: ViaLink[]): PathGeometry {
  const out: PathGeometry = { ...g }
  if (via.length) out.via = via; else delete out.via
  return out
}

/**
 * Records every intermediate vertex that sits on a device centre (same page) as a via link, replacing the old list: a vertex
 * dragged onto a device links, one dragged off unlinks. Returns the same object when nothing changes.
 */
export function withVia(g: PathGeometry, all: ReadonlyMap<string, Markup>, page: number, tol = LINK_TOLERANCE): PathGeometry {
  const pts = pathPoints(g)
  const via: ViaLink[] = []
  const devices = [...all.values()].filter(m => m.type === 'device' && m.page === page)
  for (let i = 1; i < pts.length - 1; i++) {
    const hit = nearestDevice(devices, pts[i], tol, { page })
    if (hit) via.push({ id: hit.id, i })
  }
  const cur = viaOf(g)
  if (cur.length === via.length && cur.every((v, k) => v.id === via[k].id && v.i === via[k].i)) return g
  return setVia(g, via)
}

/** Via links after a vertex was inserted at index `at` (later vertices shift up by one). */
export function viaAfterInsert(g: PathGeometry, at: number): PathGeometry {
  return g.via?.length ? setVia(g, viaOf(g).map(v => (v.i >= at ? { ...v, i: v.i + 1 } : v))) : g
}

/** Via links after vertex `index` was removed: the link on that vertex goes, later vertices shift down by one. */
export function viaAfterRemove(g: PathGeometry, index: number): PathGeometry {
  return g.via?.length ? setVia(g, viaOf(g).filter(v => v.i !== index).map(v => (v.i > index ? { ...v, i: v.i - 1 } : v))) : g
}

/** The devices a cable is chained through, in order: From, via..., To (ids that are not devices are skipped). */
export function chainDevices(g: PathGeometry, byId: ReadonlyMap<string, Markup>): { role: 'from' | 'via' | 'to'; id: string }[] {
  const out: { role: 'from' | 'via' | 'to'; id: string }[] = []
  if (g.from) out.push({ role: 'from', id: g.from })
  for (const v of viaOf(g)) if (byId.get(v.id)?.type === 'device') out.push({ role: 'via', id: v.id })
  if (g.to) out.push({ role: 'to', id: g.to })
  return out
}

/** Devices a cable passes through that exist on its page. */
export function viaCount(m: Markup, byId: ReadonlyMap<string, Markup>): number {
  const g = pathOf(m)
  return g ? viaOf(g).filter(v => { const d = byId.get(v.id); return !!d && d.type === 'device' && d.page === m.page && d.document_id === m.document_id }).length : 0
}

/** The cable with vertex `index` moved to `p` (links kept; the geometry is re-anchored). */
export function setVertex(g: PathGeometry, index: number, p: Pt): PathGeometry {
  const abs = pathPoints(g)
  if (index < 0 || index >= abs.length) return g
  abs[index] = p
  return keepLinks(pathFromPoints(abs), g)
}

/** Clears the dangling marker of every dangling end (and the link if it points at nothing). */
export function clearDangling(g: PathGeometry, m: Markup, byId: ReadonlyMap<string, Markup>): PathGeometry {
  let out = g
  for (const end of danglingEnds({ ...m, geometry: g }, byId)) out = withLink(out, end, null, false)
  return out
}

const sameGeometry = (a: PathGeometry, b: PathGeometry) =>
  a.x === b.x && a.y === b.y && a.rotation === b.rotation && a.points.length === b.points.length && a.points.every((v, i) => v === b.points[i])

/**
 * Extends a change so linked cables follow their devices, in the same undo step:
 *  - a device that moves (or resizes about a different centre) pulls the linked end point onto its new centre;
 *  - a device that is deleted, or leaves the cable's page, unlinks that end and marks it dangling;
 *  - a cable edited so an end is no longer on its device (dragged away, or the cable moved on its own) unlinks that end.
 * `all` is the state before the change (every markup of the document). Cables already in the change are updated in place.
 */
export function syncCables(change: Change, all: ReadonlyMap<string, Markup>): Change {
  const devs = new Map<string, { before: Markup | null; after: Markup | null }>()
  const pos = new Map<string, number>()
  change.forEach((c, i) => {
    const r = c.after ?? c.before!
    pos.set(r.id, i)
    if (r.type === 'device') devs.set(r.id, c)
  })
  const cableIds = new Set<string>()
  for (const c of change) if (c.after?.type === 'cable') cableIds.add(c.after.id)
  if (devs.size) {
    for (const m of all.values()) {
      const g = pathOf(m)
      if (g && ((g.from && devs.has(g.from)) || (g.to && devs.has(g.to)) || g.via?.some(v => devs.has(v.id)))) cableIds.add(m.id)
    }
  }
  if (!cableIds.size) return change
  const out: Change = change.slice()
  const extra: Change = []
  let touched = false
  for (const id of cableIds) {
    const i = pos.get(id)
    const entry = i === undefined ? undefined : out[i]
    const before = entry ? entry.before : all.get(id) ?? null
    const cur = entry ? entry.after : all.get(id) ?? null
    const g0 = cur && pathOf(cur)
    if (!cur || !g0) continue
    const bg = before && pathOf(before)
    const cableMoved = !!entry && !!bg && !sameGeometry(bg, g0)
    let g = g0
    for (const end of CABLE_ENDS) {
      const ref = g[end]
      if (!ref) continue
      const d = devs.get(ref)
      const dev = d ? d.after : all.get(ref) ?? null
      const live = !!dev && dev.type === 'device' && dev.page === cur.page && dev.document_id === cur.document_id
      if (!live) {
        // The device was deleted or moved to another page in this change: this end is now open. A reference that was already
        // missing before this change keeps showing as dangling on its own.
        if (d) g = withLink(g, end, null, true)
        continue
      }
      const c = deviceCentreOf(dev), p = endPoint(g, end)
      if (!c || !p || dist(p, c) <= LINK_TOLERANCE) continue
      const was = d?.before ? deviceCentreOf(d.before) : null
      const devMoved = !!d && (!was || dist(was, c) > 1e-6)
      if (devMoved) g = setEnd(g, end, c)
      else if (cableMoved) g = withLink(g, end, null)
    }
    for (const v of viaOf(g)) {
      const d = devs.get(v.id)
      const dev = d ? d.after : all.get(v.id) ?? null
      const live = !!dev && dev.type === 'device' && dev.page === cur.page && dev.document_id === cur.document_id
      if (!live) {
        // Device deleted / left the page: the link goes quietly, the vertex stays where it is
        if (d) g = setVia(g, viaOf(g).filter(x => x.id !== v.id || x.i !== v.i))
        continue
      }
      const c = deviceCentreOf(dev), p = pathPoints(g)[v.i]
      if (!c || !p || dist(p, c) <= LINK_TOLERANCE) continue
      const was = d?.before ? deviceCentreOf(d.before) : null
      const devMoved = !!d && (!was || dist(was, c) > 1e-6)
      if (devMoved) g = setVertex(g, v.i, c)
      else if (cableMoved) g = setVia(g, viaOf(g).filter(x => x.id !== v.id || x.i !== v.i))
    }
    if (g === g0) continue
    touched = true
    const next: Markup = { ...cur, geometry: g }
    if (entry) out[i!] = { before: entry.before, after: next }
    else extra.push({ before: all.get(id)!, after: next })
  }
  return !touched ? change : extra.length ? [...out, ...extra] : out
}

// ---- Cable properties and length

export const cableTypeId = (m: Markup): string => {
  const v = m.fields?.[CABLE_FIELD.type]
  return typeof v === 'string' ? v : ''
}

const numField = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Runs the cable stands for (conductors / parallel runs), at least 1. */
export function cableCount(m: Markup): number {
  const n = numField(m.fields?.[CABLE_FIELD.count])
  return n !== null && n >= 1 ? Math.round(n) : 1
}

/** Colour the cable is drawn in: its type's colour when it has one, else its own stroke. */
export function cableColor(m: Markup, types: ReadonlyMap<string, CableType> | undefined): string {
  const t = types?.get(cableTypeId(m))
  return t?.color || m.style.stroke || '#e03131'
}

export interface CableLength {
  /** Length as drawn, feet. */
  drawnFt: number
  slackPct: number
  dropFt: number
  /** Ends locked to a device (each adds one drop). */
  ends: number
  /** Devices the run passes through (each adds one drop when the project setting is on). */
  via: number
  /** One run: drawn x (1 + slack %) + drop x linked ends. */
  runFt: number
  count: number
  /** All runs: runFt x count. */
  totalFt: number
}

/**
 * Length of a cable: total = (drawn x (1 + slack %) + drop ft x linked ends) x count. Slack and drop come from the cable's own
 * override, else the project defaults. null when the page has no scale.
 */
export function cableLength(m: Markup, ppf: number | null, defaults: CableSettings, byId: ReadonlyMap<string, Markup>): CableLength | null {
  const g = pathOf(m)
  if (!g || !ppf) return null
  const drawnFt = polylineLength(g.points) / ppf
  const slackPct = numField(m.fields?.[CABLE_FIELD.slack]) ?? defaults.slackPct
  const dropFt = numField(m.fields?.[CABLE_FIELD.drop]) ?? defaults.dropFt
  const ends = linkedEnds(m, byId).length
  const via = viaCount(m, byId)
  const runFt = drawnFt * (1 + slackPct / 100) + dropFt * (ends + (defaults.viaDrop === false ? 0 : via))
  const count = cableCount(m)
  return { drawnFt, slackPct, dropFt, ends, via, runFt, count, totalFt: runFt * count }
}

export interface CableTotal { typeId: string; name: string; color: string; /** Cable markups. */ cables: number; /** Runs (sum of counts). */ runs: number; lengthFt: number; /** Cables on pages without a scale (not in lengthFt). */ unscaled: number }

/** Cable totals per cable type across any set of markups (one project). Untyped cables are listed as "No type". */
export function cableTotals(
  markups: Iterable<Markup>, scaleFor: (docId: string, page: number) => number | null, types: ReadonlyMap<string, CableType>, defaults: CableSettings,
): CableTotal[] {
  const list = [...markups]
  const byId = new Map(list.map(m => [m.id, m]))
  const rows = new Map<string, CableTotal>()
  for (const m of list) {
    if (!pathOf(m)) continue
    const id = types.has(cableTypeId(m)) ? cableTypeId(m) : ''
    const t = types.get(id)
    let r = rows.get(id)
    if (!r) { r = { typeId: id, name: t?.name ?? 'No type', color: t?.color ?? '#868e96', cables: 0, runs: 0, lengthFt: 0, unscaled: 0 }; rows.set(id, r) }
    r.cables++
    r.runs += cableCount(m)
    const len = cableLength(m, scaleFor(m.document_id, m.page), defaults, byId)
    if (len) r.lengthFt += len.totalFt; else r.unscaled++
  }
  return [...rows.values()].sort((a, b) => (a.typeId === '' ? 1 : 0) - (b.typeId === '' ? 1 : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** The Measure panel's "Cable runs" block for one page: total length (slack, drops and run count included) per cable type. */
export function summarizeCables(
  markups: Iterable<Markup>, ppf: number | null, types: ReadonlyMap<string, CableType>, defaults: CableSettings,
): { rows: MeasureTotal[]; total: string; unscaled: number } {
  const list = [...markups]
  const byId = new Map(list.map(m => [m.id, m]))
  const rows = new Map<string, MeasureTotal & { ft: number }>()
  let total = 0, unscaled = 0
  for (const m of list) {
    if (!pathOf(m)) continue
    const len = cableLength(m, ppf, defaults, byId)
    if (!len) { unscaled++; continue }
    const id = types.has(cableTypeId(m)) ? cableTypeId(m) : ''
    const t = types.get(id)
    let r = rows.get(id)
    if (!r) { r = { key: `cable:${id}`, label: t?.name ?? 'Cable', color: t?.color ?? (m.style.stroke || '#e03131'), value: '', ids: [], ft: 0 }; rows.set(id, r) }
    r.ids.push(m.id)
    r.ft += len.totalFt
    total += len.totalFt
  }
  return { rows: [...rows.values()].map(({ ft, ...r }) => ({ ...r, value: formatFeetInches(ft) })), total: formatFeetInches(total), unscaled }
}

// ---- Continuing a run, and drawing linked ends

/**
 * The end a "Continue run" starts from: a free end (not linked to a device) wins; when both or neither are free, the one nearest
 * to `near` (a page point), else the last point.
 */
export function pickContinueEnd(m: Markup, byId: ReadonlyMap<string, Markup>, near?: Pt | null): CableEnd {
  const g = pathOf(m)
  if (!g) return 'to'
  const linked = new Set(linkedEnds(m, byId))
  const free = CABLE_ENDS.filter(e => !linked.has(e))
  if (free.length === 1) return free[0]
  if (near) {
    const a = endPoint(g, 'from'), b = endPoint(g, 'to')
    if (a && b) return dist(near, a) < dist(near, b) ? 'from' : 'to'
  }
  return 'to'
}

/** The cable run backwards: points reversed, from / to links and open flags swapped. */
export function reverseCable(g: PathGeometry): PathGeometry {
  const out = pathFromPoints(pathPoints(g).reverse())
  if (g.to) out.from = g.to
  if (g.from) out.to = g.from
  const open = (g.open ?? []).map(e => (e === 'from' ? 'to' : 'from') as CableEnd)
  if (open.length) out.open = CABLE_ENDS.filter(e => open.includes(e))
  const last = pathPoints(g).length - 1
  if (g.via?.length) out.via = viaOf(g).map(v => ({ id: v.id, i: last - v.i })).reverse()
  return out
}

/** Absolute points of a cable oriented so that `end` is the tail (the point a continued run grows from). */
export function continueSeed(g: PathGeometry, end: CableEnd): Pt[] {
  return pathPoints(end === 'to' ? g : reverseCable(g))
}

/**
 * The cable with `extra` points appended beyond `end`. The extended end loses its old link and open flag (the caller relinks it
 * when it lands on a device); the other end keeps its own.
 */
export function extendCable(g: PathGeometry, end: CableEnd, extra: Pt[]): PathGeometry {
  const oriented = end === 'to' ? g : reverseCable(g)
  const out = pathFromPoints([...pathPoints(oriented), ...extra])
  if (oriented.from) out.from = oriented.from
  if (oriented.open?.includes('from')) out.open = ['from']
  if (oriented.via?.length) out.via = oriented.via
  return end === 'to' ? out : reverseCable(out)
}

export interface EndRing { end: CableEnd | 'via'; /** Device centre, page space. */ c: Pt; /** Symbol radius. */ r: number }

/**
 * Absolute points of a cable as drawn: an end linked to a device stops at the symbol's edge (radius `r` from its centre,
 * along the first / last segment) instead of running to the centre. Short segments are left alone.
 */
export function trimCableEnds(abs: Pt[], rings: readonly EndRing[]): Pt[] {
  const out = abs.map(p => ({ ...p }))
  if (out.length < 2) return out
  for (const ring of rings) {
    if (ring.end === 'via') continue
    const i = ring.end === 'from' ? 0 : out.length - 1
    const next = out[ring.end === 'from' ? 1 : out.length - 2]
    const p = out[i]
    const len = dist(p, next)
    if (len <= ring.r * 1.05 || len === 0) continue
    const k = ring.r / len
    out[i] = { x: p.x + (next.x - p.x) * k, y: p.y + (next.y - p.y) * k }
  }
  return out
}


/** What vertex `index` of a cable is linked to: 'from' / 'to' (first / last point) or a via link; null when unlinked. */
export function linkAt(g: PathGeometry, index: number): { kind: 'from' | 'to' | 'via'; id: string } | null {
  const n = pathPoints(g).length
  if (index === 0 && g.from) return { kind: 'from', id: g.from }
  if (index === n - 1 && n > 1 && g.to) return { kind: 'to', id: g.to }
  const v = index > 0 && index < n - 1 ? viaOf(g).find(x => x.i === index) : undefined
  return v ? { kind: 'via', id: v.id } : null
}

/**
 * Deliberately detaches vertex `index` from its device: the from / to link (no dangling marker) or the via link goes, and the
 * vertex moves `offset` page units off `devicePos` along its segment (towards the neighbouring vertex; never past half the
 * segment) so relinkEnds / withVia do not link it again. Returns the same object when the vertex is not linked.
 */
export function disconnectPoint(g: PathGeometry, index: number, devicePos: Pt, offset: number): PathGeometry {
  const link = linkAt(g, index)
  if (!link) return g
  const pts = pathPoints(g)
  const nb = pts[link.kind === 'to' ? index - 1 : index + 1]
  let dx = nb.x - devicePos.x, dy = nb.y - devicePos.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) { dx = 1; dy = 0 } else { dx /= len; dy /= len }
  const segLen = Math.hypot(nb.x - pts[index].x, nb.y - pts[index].y)
  const step = segLen > 1e-6 ? Math.min(offset, segLen / 2) : offset
  const moved = setVertex(g, index, { x: devicePos.x + dx * step, y: devicePos.y + dy * step })
  if (link.kind === 'via') return setVia(moved, viaOf(moved).filter(v => v.i !== index))
  return withLink(moved, link.kind, null, false)
}
