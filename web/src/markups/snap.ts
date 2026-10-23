// Snapping engine: a uniform-bucket spatial index over segments and points, and snapPoint() which picks the best
// snap for a pointer position. Priority: devices > markup vertices/midpoints > markup edges > PDF lines (endpoints,
// then the nearest point on a segment) > grid. Each source can be switched off in SnapSettings.
import type { BoxGeometry, Markup, PathGeometry } from './types'
import { isSheetArea } from './areas'
import { deviceCenter } from './geometry'
import type { Pt } from './geometry'
import { GRID_SNAP_MIN_PX, SNAP_RADIUS_PX } from './snapConfig'
import type { SnapSettings } from './snapConfig'

export type SnapKind = 'device' | 'endpoint' | 'midpoint' | 'edge' | 'pdf' | 'grid'

export interface SnapHit {
  point: Pt
  kind: SnapKind
  /** Direction of the line snapped to, degrees in (-90, 90] (0 = along the page's x axis, 90 = down). Absent for points and the grid. */
  angle?: number
  /** pdf only: the point is an end of a PDF segment (a corner), not just somewhere along it. */
  end?: boolean
}

/** Direction of a segment as an undirected line angle in (-90, 90]. */
export function lineAngle(x1: number, y1: number, x2: number, y2: number): number {
  let a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
  if (a > 90) a -= 180
  else if (a <= -90) a += 180
  return Math.round(a * 1000) / 1000
}

type PointKind = 'device' | 'endpoint' | 'midpoint'

const CELL = 48
const OFF = 4096
const cellKey = (cx: number, cy: number) => (cx + OFF) * 8192 + (cy + OFF)

interface Cell { s: number[]; p: number[] }

export class SegIndex {
  private segs: number[] = []
  private segIds: (string | undefined)[] = []
  private pts: number[] = []
  private ptKinds: PointKind[] = []
  private ptAngles: number[] = []
  private ptIds: (string | undefined)[] = []
  private cells = new Map<number, Cell>()
  private stamp: Int32Array | null = null
  private tick = 0

  get segmentCount() { return this.segs.length / 4 }
  get pointCount() { return this.pts.length / 2 }

  private cell(cx: number, cy: number): Cell {
    const k = cellKey(cx, cy)
    let c = this.cells.get(k)
    if (!c) { c = { s: [], p: [] }; this.cells.set(k, c) }
    return c
  }

  addPoint(x: number, y: number, kind: PointKind, id?: string, angle = NaN) {
    const i = this.ptKinds.length
    this.pts.push(x, y); this.ptKinds.push(kind); this.ptAngles.push(angle); this.ptIds.push(id)
    this.cell(Math.floor(x / CELL), Math.floor(y / CELL)).p.push(i)
  }

  addSegment(x1: number, y1: number, x2: number, y2: number, id?: string) {
    const i = this.segIds.length
    this.segs.push(x1, y1, x2, y2); this.segIds.push(id)
    this.stamp = null
    const len = Math.hypot(x2 - x1, y2 - y1)
    const n = Math.max(1, Math.ceil(len / (CELL / 2)))
    let last = Number.NaN
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const cx = Math.floor((x1 + (x2 - x1) * t) / CELL), cy = Math.floor((y1 + (y2 - y1) * t) / CELL)
      const key = cellKey(cx, cy)
      if (key === last) continue
      last = key
      const c = this.cell(cx, cy)
      if (c.s[c.s.length - 1] !== i) c.s.push(i)
    }
  }

  /** Index over a flat [x1, y1, x2, y2, ...] list (PDF lines). */
  static fromSegments(flat: ArrayLike<number>): SegIndex {
    const ix = new SegIndex()
    for (let i = 0; i + 3 < flat.length; i += 4) ix.addSegment(flat[i], flat[i + 1], flat[i + 2], flat[i + 3])
    return ix
  }

  /** Cells covering a circle of radius r (segments are indexed by samples, so widen by a quarter cell). */
  private *cellsAround(x: number, y: number, r: number): Generator<Cell> {
    const R = r + CELL / 4
    const x0 = Math.floor((x - R) / CELL), x1 = Math.floor((x + R) / CELL)
    const y0 = Math.floor((y - R) / CELL), y1 = Math.floor((y + R) / CELL)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) { yield* this.cells.values(); return }
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const c = this.cells.get(cellKey(cx, cy))
      if (c) yield c
    }
  }

  /** Nearest indexed point of one of `kinds` within r, or null. */
  nearestPoint(x: number, y: number, r: number, kinds: readonly PointKind[], skip?: ReadonlySet<string>): { x: number; y: number; kind: PointKind; angle: number; d: number } | null {
    let best: { x: number; y: number; kind: PointKind; angle: number; d: number } | null = null
    for (const c of this.cellsAround(x, y, r)) for (const i of c.p) {
      if (!kinds.includes(this.ptKinds[i])) continue
      const id = this.ptIds[i]
      if (id && skip?.has(id)) continue
      const px = this.pts[i * 2], py = this.pts[i * 2 + 1]
      const d = Math.hypot(px - x, py - y)
      if (d <= r && (!best || d < best.d)) best = { x: px, y: py, kind: this.ptKinds[i], angle: this.ptAngles[i], d }
    }
    return best
  }

  /**
   * Nearest point on any segment within r. With `endpointsFirst` a segment end within r wins over a nearer
   * point along a segment (PDF corners).
   */
  nearestOnSegment(x: number, y: number, r: number, skip?: ReadonlySet<string>, endpointsFirst = false): { x: number; y: number; angle: number; d: number; end: boolean } | null {
    if (!this.stamp || this.stamp.length !== this.segIds.length) this.stamp = new Int32Array(this.segIds.length)
    const stamp = this.stamp
    const mark = ++this.tick
    let best: { x: number; y: number; angle: number; d: number; end: boolean } | null = null
    let bestEnd: { x: number; y: number; angle: number; d: number; end: boolean } | null = null
    for (const c of this.cellsAround(x, y, r)) for (const i of c.s) {
      if (stamp[i] === mark) continue
      stamp[i] = mark
      const id = this.segIds[i]
      if (id && skip?.has(id)) continue
      const x1 = this.segs[i * 4], y1 = this.segs[i * 4 + 1], x2 = this.segs[i * 4 + 2], y2 = this.segs[i * 4 + 3]
      const dx = x2 - x1, dy = y2 - y1
      const len2 = dx * dx + dy * dy
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0
      const qx = x1 + dx * t, qy = y1 + dy * t
      const d = Math.hypot(qx - x, qy - y)
      if (d > r) continue
      const angle = lineAngle(x1, y1, x2, y2)
      if (!best || d < best.d) best = { x: qx, y: qy, angle, d, end: false }
      if (endpointsFirst) {
        for (const [ex, ey] of [[x1, y1], [x2, y2]]) {
          const de = Math.hypot(ex - x, ey - y)
          if (de <= r && (!bestEnd || de < bestEnd.d)) bestEnd = { x: ex, y: ey, angle, d: de, end: true }
        }
      }
    }
    return bestEnd ?? best
  }
}

// ---- Markups -> index

const CLOSED_TYPES = new Set(['polygon', 'measure-area', 'area'])
const SKIP_TYPES = new Set(['freehand'])

const rotate = (lx: number, ly: number, deg: number) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return { x: lx * c - ly * s, y: lx * s + ly * c }
}

/** A path markup's vertices in page space. */
export function pathPoints(g: PathGeometry): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i + 1 < g.points.length; i += 2) {
    const r = g.rotation ? rotate(g.points[i], g.points[i + 1], g.rotation) : { x: g.points[i], y: g.points[i + 1] }
    out.push({ x: g.x + r.x, y: g.y + r.y })
  }
  return out
}

/** A box markup's corners in page space, clockwise from its top-left. */
export function boxCorners(g: BoxGeometry): Pt[] {
  return [[0, 0], [g.width, 0], [g.width, g.height], [0, g.height]].map(([lx, ly]) => {
    const r = g.rotation ? rotate(lx, ly, g.rotation) : { x: lx, y: ly }
    return { x: g.x + r.x, y: g.y + r.y }
  })
}

/**
 * Points of a markup that snap to others and that a drag should line up: a device's centre; a box's corners and centre;
 * a path's vertices (all, capped at 40, else the ends).
 */
export function handlePoints(m: Markup): Pt[] {
  const g = m.geometry
  if ('width' in g) {
    if (m.type === 'device') return [deviceCenter(g)]
    return [...boxCorners(g), deviceCenter(g)]
  }
  const pts = pathPoints(g)
  return pts.length <= 40 ? pts : [pts[0], pts[pts.length - 1]]
}

function addPolyline(ix: SegIndex, pts: Pt[], closed: boolean, id: string) {
  const n = pts.length
  for (let i = 0; i < n; i++) ix.addPoint(pts[i].x, pts[i].y, 'endpoint', id)
  const last = closed && n > 2 ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    if (a.x === b.x && a.y === b.y) continue
    ix.addSegment(a.x, a.y, b.x, b.y, id)
    ix.addPoint((a.x + b.x) / 2, (a.y + b.y) / 2, 'midpoint', id, lineAngle(a.x, a.y, b.x, b.y))
  }
}

/** Index of the snap points and edges of `markups` (page space). Each entry carries its markup id so a drag can skip its own. */
export function buildMarkupIndex(markups: Iterable<Markup>): SegIndex {
  const ix = new SegIndex()
  for (const m of markups) {
    if (SKIP_TYPES.has(m.type) || isSheetArea(m)) continue
    const g = m.geometry
    if (!g || typeof g.x !== 'number') continue
    if ('width' in g) {
      if (m.type === 'device') { const c = deviceCenter(g); ix.addPoint(c.x, c.y, 'device', m.id) }
      else addPolyline(ix, boxCorners(g), true, m.id)
    } else if (Array.isArray(g.points)) {
      if (m.type === 'count') { const p = pathPoints(g)[0]; if (p) ix.addPoint(p.x, p.y, 'endpoint', m.id) }
      else addPolyline(ix, pathPoints(g), CLOSED_TYPES.has(m.type), m.id)
    }
  }
  return ix
}

// ---- Snapping

export interface SnapEnv {
  settings: SnapSettings
  /** PDF line segments, or null while not loaded / switched off. */
  pdf: SegIndex | null
  markups: SegIndex | null
  /** Grid step in page points (0 = no grid). */
  gridStep: number
}

export interface SnapOpts {
  /** Markup ids that are being moved / edited: never snapped to. */
  skip?: ReadonlySet<string>
  /** Ctrl held: no snapping for this action. */
  off?: boolean
  /** Extra vertices of the thing being drawn (so a polygon can close on its first point). */
  extra?: readonly Pt[]
}

/** True when snapping can happen at all (cheap check before doing work). */
export const snapActive = (env: SnapEnv | null | undefined, off?: boolean): env is SnapEnv => !!env && env.settings.on && !off

/** Best snap for `p` within SNAP_RADIUS_PX screen pixels at `zoom`, or null. */
export function snapPoint(env: SnapEnv, p: Pt, zoom: number, opts: SnapOpts = {}): SnapHit | null {
  const s = env.settings
  if (!s.on || opts.off) return null
  const r = SNAP_RADIUS_PX / Math.max(zoom, 1e-6)
  const mk = env.markups
  if (s.devices && mk) {
    const d = mk.nearestPoint(p.x, p.y, r, ['device'], opts.skip)
    if (d) return { point: { x: d.x, y: d.y }, kind: 'device' }
  }
  if (s.markups) {
    let best: { x: number; y: number; d: number; kind: SnapKind; angle?: number } | null = null
    for (const e of opts.extra ?? []) {
      const d = Math.hypot(e.x - p.x, e.y - p.y)
      if (d <= r && (!best || d < best.d)) best = { x: e.x, y: e.y, d, kind: 'endpoint' }
    }
    const v = mk?.nearestPoint(p.x, p.y, r, ['endpoint', 'midpoint'], opts.skip)
    if (v && (!best || v.d < best.d)) best = { x: v.x, y: v.y, d: v.d, kind: v.kind, ...(v.kind === 'midpoint' && !isNaN(v.angle) ? { angle: v.angle } : {}) }
    if (best) return { point: { x: best.x, y: best.y }, kind: best.kind, ...(best.angle !== undefined ? { angle: best.angle } : {}) }
    const e = mk?.nearestOnSegment(p.x, p.y, r, opts.skip)
    if (e) return { point: { x: e.x, y: e.y }, kind: 'edge', angle: e.angle }
  }
  if (s.pdf && env.pdf) {
    const h = env.pdf.nearestOnSegment(p.x, p.y, r, undefined, true)
    if (h) return { point: { x: h.x, y: h.y }, kind: 'pdf', angle: h.angle, ...(h.end ? { end: true } : {}) }
  }
  if (s.grid && env.gridStep > 0 && env.gridStep * zoom >= GRID_SNAP_MIN_PX) {
    const g = env.gridStep
    const gx = Math.round(p.x / g) * g, gy = Math.round(p.y / g) * g
    if (Math.hypot(gx - p.x, gy - p.y) <= r) return { point: { x: gx, y: gy }, kind: 'grid' }
  }
  return null
}

/** The snapped point, or `p` itself when nothing snaps. */
export function snapOr(env: SnapEnv | null | undefined, p: Pt, zoom: number, opts: SnapOpts = {}): Pt {
  return (env && snapPoint(env, p, zoom, opts)?.point) || p
}

const RANK: Record<SnapKind, number> = { device: 0, endpoint: 1, midpoint: 1, edge: 2, pdf: 3, grid: 4 }

/**
 * Snap whichever of `handles` (points of the thing being dragged) lands on the strongest source, nearest first.
 * Returns the shift to apply to the whole thing, the hit and the handle that snapped.
 */
export function snapHandles(env: SnapEnv, handles: readonly Pt[], zoom: number, opts: SnapOpts = {}): { dx: number; dy: number; hit: SnapHit; handle: Pt } | null {
  let best: { dx: number; dy: number; hit: SnapHit; handle: Pt; d: number } | null = null
  for (const h of handles) {
    const hit = snapPoint(env, h, zoom, opts)
    if (!hit) continue
    const d = Math.hypot(hit.point.x - h.x, hit.point.y - h.y)
    if (!best || RANK[hit.kind] < RANK[best.hit.kind] || (RANK[hit.kind] === RANK[best.hit.kind] && d < best.d)) {
      best = { dx: hit.point.x - h.x, dy: hit.point.y - h.y, hit, handle: h, d }
    }
  }
  return best
}
