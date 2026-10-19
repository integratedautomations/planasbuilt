import { isSheetArea } from './areas'
import type { Markup } from './types'

export interface Rect { x: number; y: number; width: number; height: number }

/** Normalized rect from two opposite corners. */
export function rectFromCorners(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** Axis-aligned page-space bounds of a markup (rotation about x/y applied). Tiny shapes are padded so they stay hittable. */
export function markupBounds(m: Markup): Rect {
  const g = m.geometry
  const local: [number, number][] = 'points' in g
    ? Array.from({ length: Math.floor(g.points.length / 2) }, (_, i) => [g.points[i * 2], g.points[i * 2 + 1]] as [number, number])
    : [[0, 0], [g.width, 0], [g.width, g.height], [0, g.height]]
  if (!local.length) local.push([0, 0])
  const rad = ((g.rotation || 0) * Math.PI) / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [dx, dy] of local) {
    const x = g.x + dx * cos - dy * sin, y = g.y + dx * sin + dy * cos
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  const pad = 4
  if (x1 - x0 < pad) { x0 -= pad; x1 += pad }
  if (y1 - y0 < pad) { y0 -= pad; y1 += pad }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height

export const rectContains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

/**
 * Ids of markups a selection box picks: anything whose bounds intersect it, except locked ones and
 * the sheet area. Other areas count only when the box fully contains them, so a box inside a room does not grab the room.
 */
export function markupsInBox(markups: Iterable<Markup>, box: Rect, lockedIds: Set<string>): string[] {
  const out: string[] = []
  for (const m of markups) {
    if (lockedIds.has(m.id) || isSheetArea(m)) continue
    const b = markupBounds(m)
    if (m.type === 'area' ? rectContains(box, b) : rectsIntersect(box, b)) out.push(m.id)
  }
  return out
}
