import type { BoxGeometry, PathGeometry } from './types'

export interface Pt { x: number; y: number }

/** Snap the vector a→b to the nearest 45° while keeping its length (Shift while drawing). */
export function snap45(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: a.x + len * Math.cos(angle), y: a.y + len * Math.sin(angle) }
}

/** Normalized box from two drag corners; `square` forces equal sides (Shift). */
export function boxFromDrag(a: Pt, b: Pt, square = false): BoxGeometry {
  let w = b.x - a.x, h = b.y - a.y
  if (square) {
    const s = Math.max(Math.abs(w), Math.abs(h))
    w = Math.sign(w || 1) * s
    h = Math.sign(h || 1) * s
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), width: Math.abs(w), height: Math.abs(h), rotation: 0 }
}

/** Builds path geometry from absolute points, anchored at the first point. */
export function pathFromPoints(abs: Pt[]): PathGeometry {
  const o = abs[0]
  return { x: o.x, y: o.y, rotation: 0, points: abs.flatMap(p => [p.x - o.x, p.y - o.y]) }
}

/** Bake a Konva transform (scale) into box size so stored markups never carry scale. */
export function bakeBox(g: { x: number; y: number; rotation: number; width: number; height: number }, scaleX: number, scaleY: number): BoxGeometry {
  return {
    x: g.x, y: g.y, rotation: g.rotation,
    width: Math.max(2, Math.abs(g.width * scaleX)),
    height: Math.max(2, Math.abs(g.height * scaleY)),
  }
}

export function bakePath(g: { x: number; y: number; rotation: number; points: number[] }, scaleX: number, scaleY: number): PathGeometry {
  return {
    x: g.x, y: g.y, rotation: g.rotation,
    points: g.points.map((v, i) => (i % 2 === 0 ? v * scaleX : v * scaleY)),
  }
}

/** Center of a (possibly rotated about its top-left) box, in page space. */
export function deviceCenter(g: BoxGeometry): Pt {
  const a = (g.rotation * Math.PI) / 180
  const cx = g.width / 2, cy = g.height / 2
  return { x: g.x + cx * Math.cos(a) - cy * Math.sin(a), y: g.y + cx * Math.sin(a) + cy * Math.cos(a) }
}

/** Removes points closer than `minDist` to the previous kept point (keeps freehand light). */
export function simplify(points: Pt[], minDist = 1.5): Pt[] {
  if (points.length < 3) return points
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1]
    if (Math.hypot(points[i].x - last.x, points[i].y - last.y) >= minDist) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

/**
 * Scallops for a revision cloud around a w×h box: returns arc centers along the perimeter
 * with the arc radius, spaced evenly so each side fits a whole number of bumps.
 */
export function cloudArcs(w: number, h: number, size: number) {
  const arcs: { cx: number; cy: number; r: number; start: number; end: number }[] = []
  const side = (x0: number, y0: number, x1: number, y1: number, outward: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0)
    const n = Math.max(1, Math.round(len / size))
    const r = len / n / 2
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      arcs.push({ cx: x0 + (x1 - x0) * t, cy: y0 + (y1 - y0) * t, r, start: outward - Math.PI / 2, end: outward + Math.PI / 2 })
    }
  }
  // clockwise: top, right, bottom, left; outward normal angles
  side(0, 0, w, 0, -Math.PI / 2)
  side(w, 0, w, h, 0)
  side(w, h, 0, h, Math.PI / 2)
  side(0, h, 0, 0, Math.PI)
  return arcs
}

/** True when a markup's geometry is safe to draw (finite numbers, points array well formed). Guards the canvas against bad data. */
export function hasDrawableGeometry(m: { geometry?: unknown }): boolean {
  const g = m.geometry as Record<string, unknown> | null | undefined
  if (!g || typeof g !== 'object') return false
  const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  if (!fin(g.x) || !fin(g.y) || (g.rotation !== undefined && !fin(g.rotation))) return false
  if ('points' in g) return Array.isArray(g.points) && g.points.length % 2 === 0 && g.points.every(fin)
  return fin(g.width) && fin(g.height)
}

/**
 * Points of a click-drawn path (polyline, polygon, cable, area...) when it is finished. While drawing, the last point follows
 * the mouse; `rubber` (default true) drops it so Enter finishes at the last clicked point. Repeats (a double-click's second
 * click) are removed too.
 */
export function finalizeClickPoints(pts: Pt[], rubber = true): Pt[] {
  const kept = rubber && pts.length > 1 ? pts.slice(0, -1) : pts
  return kept.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.5)
}
