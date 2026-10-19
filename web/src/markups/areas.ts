import type { Markup, PathGeometry } from './types'
import type { Pt } from './geometry'
import { deviceCenter } from './geometry'

/**
 * Named, nested areas. An area is a Markup of type 'area' (always a closed polygon).
 * `text` is its name. `fields.parent_id` optionally overrides the automatic parent.
 * `fields.sheet === true` marks the page-level "sheet area": it covers the whole page, is the
 * root for everything on that page, and is never drawn as an outline.
 */

export const isArea = (m: Markup) => m.type === 'area'
export const isSheetArea = (m: Markup) => m.type === 'area' && m.fields?.sheet === true
export const areaName = (m: Markup) => m.text.trim() || 'Unnamed area'

/** Absolute page-space vertices of a path markup, honoring the group's rotation about its x/y. */
export function absolutePoints(m: Markup): Pt[] {
  const g = m.geometry as PathGeometry
  if (!('points' in g)) return []
  const a = (g.rotation * Math.PI) / 180
  const cos = Math.cos(a), sin = Math.sin(a)
  const out: Pt[] = []
  for (let i = 0; i + 1 < g.points.length; i += 2) {
    const px = g.points[i], py = g.points[i + 1]
    out.push({ x: g.x + px * cos - py * sin, y: g.y + px * sin + py * cos })
  }
  return out
}

/** Ray casting. Points exactly on an edge may go either way. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function polygonAreaAbs(poly: Pt[]): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y
  return Math.abs(s) / 2
}

/** Page-space point that decides which area a markup belongs to. */
export function anchorPoint(m: Markup): Pt | null {
  const g = m.geometry
  if ('width' in g) return deviceCenter(g) // device and every other box type: the box center
  return absolutePoints(m)[0] ?? null // paths: the first point
}

export interface AreaIndex {
  /** Resolved parent id per area (null for roots). */
  parents: Map<string, string | null>
  byId: Map<string, Markup>
  polys: Map<string, Pt[]>
  sizes: Map<string, number>
  /** Number of ancestors; roots are 0. */
  depth: Map<string, number>
}

/**
 * Builds the hierarchy for a set of areas (any pages; each page is resolved on its own).
 * Parent = override (fields.parent_id) if valid, else the smallest other area on the page that
 * contains all its vertices, else the page's sheet area, else none. Cycles are impossible: the
 * automatic parent is strictly larger (ties broken by id) and an override that would loop is ignored.
 */
export function buildAreaIndex(areas: Markup[]): AreaIndex {
  const list = areas.filter(isArea)
  const byId = new Map(list.map(a => [a.id, a]))
  const polys = new Map(list.map(a => [a.id, absolutePoints(a)]))
  const sizes = new Map(list.map(a => [a.id, polygonAreaAbs(polys.get(a.id)!)]))
  const parents = new Map<string, string | null>()
  const sheetOf = new Map<number, string>()
  for (const a of list) if (isSheetArea(a) && !sheetOf.has(a.page)) sheetOf.set(a.page, a.id)

  for (const a of list) {
    if (isSheetArea(a)) { parents.set(a.id, null); continue }
    const poly = polys.get(a.id)!, size = sizes.get(a.id)!
    let best: Markup | null = null
    for (const c of list) {
      if (c.id === a.id || c.page !== a.page || isSheetArea(c)) continue
      const cs = sizes.get(c.id)!
      if (!(cs > size || (cs === size && c.id < a.id))) continue
      if (!poly.length || !poly.every(v => pointInPolygon(v, polys.get(c.id)!))) continue
      if (!best || cs < sizes.get(best.id)! || (cs === sizes.get(best.id)! && c.id < best.id)) best = c
    }
    parents.set(a.id, best?.id ?? sheetOf.get(a.page) ?? null)
  }

  const reaches = (from: string | null, target: string) => {
    for (let id = from, n = 0; id && n <= list.length; id = parents.get(id) ?? null, n++) if (id === target) return true
    return false
  }
  for (const a of [...list].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const o = a.fields?.parent_id
    if (isSheetArea(a) || typeof o !== 'string' || !o || o === a.id) continue
    const c = byId.get(o)
    if (!c || c.page !== a.page || reaches(o, a.id)) continue
    parents.set(a.id, o)
  }

  const depth = new Map<string, number>()
  for (const a of list) {
    let d = 0
    for (let id = parents.get(a.id) ?? null; id && d <= list.length; id = parents.get(id) ?? null) d++
    depth.set(a.id, d)
  }
  return { parents, byId, polys, sizes, depth }
}

/** Deepest area containing the markup's anchor (the page's sheet area as fallback). */
export function areaIdOf(idx: AreaIndex, m: Markup): string | null {
  const p = anchorPoint(m)
  let best: string | null = null
  let sheet: string | null = null
  for (const [id, a] of idx.byId) {
    if (a.page !== m.page) continue
    if (isSheetArea(a)) { sheet = id; continue }
    if (!p || !pointInPolygon(p, idx.polys.get(id)!)) continue
    if (!best) { best = id; continue }
    const d = idx.depth.get(id)!, bd = idx.depth.get(best)!
    const s = idx.sizes.get(id)!, bs = idx.sizes.get(best)!
    if (d > bd || (d === bd && (s < bs || (s === bs && id < best)))) best = id
  }
  return best ?? sheet
}

/** Names from the outermost area down to `id` (inclusive). An unnamed sheet root is skipped. */
export function pathToArea(idx: AreaIndex, id: string | null): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const a = idx.byId.get(id)
    if (!a) break
    if (!(isSheetArea(a) && !a.text.trim())) names.unshift(areaName(a))
    id = idx.parents.get(id) ?? null
  }
  return names
}

/** Path for a markup using a prebuilt index (use this in loops). For an area it is the area's own path. */
export function areaPathIn(idx: AreaIndex, m: Markup): string[] {
  return pathToArea(idx, isArea(m) ? m.id : areaIdOf(idx, m))
}

/** Area path of a markup, or of an area itself: names from the outermost area. `areas` may span pages. */
export function areaPath(m: Markup, areas: Markup[]): string[] {
  return areaPathIn(buildAreaIndex(areas), m)
}

/** Devices per area, counting devices in nested areas too. */
export function deviceCounts(idx: AreaIndex, markups: Iterable<Markup>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of markups) {
    if (m.type !== 'device') continue
    for (let id = areaIdOf(idx, m), n = 0; id && n <= idx.byId.size; id = idx.parents.get(id) ?? null, n++) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** Areas that may be chosen as manual parent: same page, not itself, not its own descendant. */
export function parentChoices(idx: AreaIndex, a: Markup): Markup[] {
  return [...idx.byId.values()].filter(c => {
    if (c.id === a.id || c.page !== a.page) return false
    for (let id: string | null = c.id, n = 0; id && n <= idx.byId.size; id = idx.parents.get(id) ?? null, n++) if (id === a.id) return false
    return true
  })
}

/** Bounding box of an area's absolute outline. */
export function areaBounds(idx: AreaIndex, id: string) {
  const poly = idx.polys.get(id) ?? []
  if (!poly.length) return null
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y)
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}
