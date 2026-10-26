// Editing the control points of a path markup: insert a point on a segment (Shift+click) and delete one (right-click or
// long-press on a point). Pure helpers working on markup geometry (local points + x/y/rotation).
import type { Pt } from './geometry'
import type { Markup, MarkupType, PathGeometry } from './types'

/** Path types whose points can be added and removed (two-point lines keep exactly two). */
export const VERTEX_EDIT_TYPES: readonly MarkupType[] = ['polyline', 'polygon', 'cable', 'measure-polylength', 'measure-area', 'area']
const CLOSED_TYPES: readonly MarkupType[] = ['polygon', 'measure-area', 'area']

export const isClosedPath = (t: MarkupType) => CLOSED_TYPES.includes(t)
/** Fewest points a shape can keep: 2 for an open line, 3 for a closed shape. */
export const minVertices = (t: MarkupType) => (isClosedPath(t) ? 3 : 2)

export const canEditVertices = (m: Markup) =>
  VERTEX_EDIT_TYPES.includes(m.type) && !!m.geometry && 'points' in m.geometry && !(m.type === 'area' && m.fields?.sheet === true)

/** A page-space point in the markup's local space. */
export function toLocal(g: { x: number; y: number; rotation: number }, p: Pt): Pt {
  const a = (g.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const dx = p.x - g.x, dy = p.y - g.y
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos }
}

export interface SegmentHit { /** Index of the segment's first vertex. */ index: number; point: Pt; dist: number }

/** The segment of a local-space polyline nearest to `p`, with the closest point on it. */
export function nearestSegment(points: number[], closed: boolean, p: Pt): SegmentHit | null {
  const n = Math.floor(points.length / 2)
  if (n < 2) return null
  let best: SegmentHit | null = null
  const segs = closed && n > 2 ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const ax = points[i * 2], ay = points[i * 2 + 1]
    const j = (i + 1) % n
    const bx = points[j * 2], by = points[j * 2 + 1]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2))
    const q = { x: ax + t * dx, y: ay + t * dy }
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (!best || d < best.dist) best = { index: i, point: q, dist: d }
  }
  return best
}

/**
 * Geometry with a new control point on the segment nearest to a page-space point, or null when the point is farther than `tol`
 * (page units) from every segment, or lands on an existing vertex.
 */
export function insertVertex(m: Markup, pagePt: Pt, tol: number): { geometry: PathGeometry; index: number } | null {
  if (!canEditVertices(m)) return null
  const g = m.geometry as PathGeometry
  const hit = nearestSegment(g.points, isClosedPath(m.type), toLocal(g, pagePt))
  if (!hit || hit.dist > tol) return null
  const n = g.points.length / 2
  const j = (hit.index + 1) % n
  const near = (k: number) => Math.hypot(g.points[k * 2] - hit.point.x, g.points[k * 2 + 1] - hit.point.y) < 0.5
  if (near(hit.index) || near(j)) return null
  const at = hit.index + 1
  const points = [...g.points.slice(0, at * 2), hit.point.x, hit.point.y, ...g.points.slice(at * 2)]
  return { geometry: { ...g, points }, index: at }
}

/** Can vertex `index` be removed without dropping below the minimum for the shape? */
export function canDeleteVertex(m: Markup, index: number): boolean {
  if (!canEditVertices(m)) return false
  const n = (m.geometry as PathGeometry).points.length / 2
  return Number.isInteger(index) && index >= 0 && index < n && n > minVertices(m.type)
}

/** Geometry without vertex `index`, or null when that would leave too few points. */
export function removeVertex(m: Markup, index: number): PathGeometry | null {
  if (!canDeleteVertex(m, index)) return null
  const g = m.geometry as PathGeometry
  const points = g.points.filter((_, i) => Math.floor(i / 2) !== index)
  return { ...g, points }
}
