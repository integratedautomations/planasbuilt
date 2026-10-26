// "Align with nearby devices": while placing or moving a device, snap its x or y to a nearby device of the same type (or set)
// that shares nearly the same x or y, so rows and columns of devices line up. Pure; the canvas draws the guide lines.
import { deviceCenter } from './geometry'
import type { Pt } from './geometry'
import type { Markup } from './types'

export interface AlignGuide { /** The device centre aligned to. */ from: Pt; /** The (snapped) point being placed. */ to: Pt; axis: 'x' | 'y' }
export interface AlignResult { point: Pt; guides: AlignGuide[] }

/** Search distance when the page has a scale: this many feet. */
export const ALIGN_SEARCH_FEET = 40
/** Search distance (page points) when it has none. */
export const ALIGN_SEARCH_POINTS = 300

/** Search radius in page points for a page scale (points per foot, or null). */
export const alignRadius = (pointsPerFoot: number | null | undefined) => (pointsPerFoot && pointsPerFoot > 0 ? ALIGN_SEARCH_FEET * pointsPerFoot : ALIGN_SEARCH_POINTS)

export interface AlignOpts {
  page?: number
  /** Device type of the one being placed; with it only devices of that type count, else only devices of the same set. */
  typeId?: string | null
  setId?: string | null
  /** Max distance (page points) between the two x (or y) values for them to align. */
  tol: number
  /** Only devices within this distance of `p` are considered. */
  radius: number
  /** Ids being moved (never aligned to). */
  skip?: ReadonlySet<string>
}

/**
 * The point `p` (a device centre) with x and / or y pulled onto the nearest-in-line device of the same type (same set when no
 * type is given), and the guide lines to draw. null when nothing lines up.
 */
export function alignWithNearby(p: Pt, devices: Iterable<Markup>, o: AlignOpts): AlignResult | null {
  let bx: { d: number; c: Pt } | null = null, by: { d: number; c: Pt } | null = null
  for (const m of devices) {
    if (m.type !== 'device' || !('width' in m.geometry) || o.skip?.has(m.id)) continue
    if (o.page !== undefined && m.page !== o.page) continue
    if (o.typeId ? m.device_type_id !== o.typeId : !o.setId || m.symbol_set_id !== o.setId) continue
    const c = deviceCenter(m.geometry)
    const dx = Math.abs(c.x - p.x), dy = Math.abs(c.y - p.y)
    if (Math.hypot(c.x - p.x, c.y - p.y) > o.radius) continue
    // Same spot as the device itself: nothing to line up with
    if (dx < 1e-9 && dy < 1e-9) continue
    if (dx <= o.tol && (!bx || dx < bx.d)) bx = { d: dx, c }
    if (dy <= o.tol && (!by || dy < by.d)) by = { d: dy, c }
  }
  if (!bx && !by) return null
  const point = { x: bx ? bx.c.x : p.x, y: by ? by.c.y : p.y }
  const guides: AlignGuide[] = []
  if (bx) guides.push({ from: bx.c, to: point, axis: 'x' })
  if (by) guides.push({ from: by.c, to: point, axis: 'y' })
  return { point, guides }
}
