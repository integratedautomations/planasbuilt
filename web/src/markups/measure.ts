import type { Markup, PathGeometry } from './types'
import { formatArea, formatLength } from '../units'

/** Sum of segment lengths of [x0,y0,x1,y1,...] points, in the same units. */
export function polylineLength(points: number[]): number {
  let total = 0
  for (let i = 2; i < points.length; i += 2) total += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1])
  return total
}

/** Absolute polygon area (shoelace). */
export function polygonArea(points: number[]): number {
  const n = Math.floor(points.length / 2)
  if (n < 3) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += points[2 * i] * points[2 * j + 1] - points[2 * j] * points[2 * i + 1]
  }
  return Math.abs(sum) / 2
}

/** Closed perimeter. */
export function polygonPerimeter(points: number[]): number {
  const n = Math.floor(points.length / 2)
  if (n < 2) return 0
  return polylineLength(points) + Math.hypot(points[0] - points[2 * n - 2], points[1] - points[2 * n - 1])
}

/** Point at half the path length. */
export function pathMidpoint(points: number[]): { x: number; y: number } {
  const total = polylineLength(points)
  if (points.length < 4 || total === 0) return { x: points[0] ?? 0, y: points[1] ?? 0 }
  let left = total / 2
  for (let i = 2; i < points.length; i += 2) {
    const seg = Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1])
    if (left <= seg && seg > 0) {
      const t = left / seg
      return { x: points[i - 2] + t * (points[i] - points[i - 2]), y: points[i - 1] + t * (points[i + 1] - points[i - 1]) }
    }
    left -= seg
  }
  return { x: points[points.length - 2], y: points[points.length - 1] }
}

/** Area centroid, falling back to the vertex average for degenerate shapes. */
export function polygonCentroid(points: number[]): { x: number; y: number } {
  const n = Math.floor(points.length / 2)
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const f = points[2 * i] * points[2 * j + 1] - points[2 * j] * points[2 * i + 1]
    a += f
    cx += (points[2 * i] + points[2 * j]) * f
    cy += (points[2 * i + 1] + points[2 * j + 1]) * f
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0
    for (let i = 0; i < n; i++) { sx += points[2 * i]; sy += points[2 * i + 1] }
    return { x: n ? sx / n : 0, y: n ? sy / n : 0 }
  }
  return { x: cx / (3 * a), y: cy / (3 * a) }
}

/** `12'-6 1/2"` or decimal feet, per the user's units pref (see units.ts). Kept under this name for existing callers. */
export const formatFeetInches = formatLength

export { formatArea }

const NUM = '\\d+(?:\\.\\d+)?'
const BARE = new RegExp(`^${NUM}$`)
const WITH_MARKS = new RegExp(`^(?:(${NUM})\\s*')?[\\s-]*(?:(${NUM})?\\s*(?:(\\d+)\\s*/\\s*(\\d+))?\\s*"?)?$`)

/** Parses `12'6"`, `12' 6 1/2"`, `12'-6"`, `12.5`, `12'`, `150"`, `6 1/2"` into feet. */
export function parseFeetInches(text: string): number | null {
  const t = text.trim().replace(/[’′]/g, "'").replace(/[”″]/g, '"')
  if (!t) return null
  if (BARE.test(t)) return parseFloat(t)
  const m = WITH_MARKS.exec(t)
  if (!m) return null
  const [, ftS, inS, numS, denS] = m
  const hasInch = inS !== undefined || numS !== undefined
  if (ftS === undefined && !hasInch) return null
  // Inches with no feet part need the inch mark ("6 1/2"" is inches; "6 1/2" is ambiguous)
  if (ftS === undefined && !t.endsWith('"')) return null
  let inches = inS ? parseFloat(inS) : 0
  if (numS !== undefined) {
    const den = parseInt(denS, 10)
    if (!den) return null
    inches += parseInt(numS, 10) / den
  }
  return (ftS ? parseFloat(ftS) : 0) + inches / 12
}

export interface ScalePreset { label: string; pointsPerFoot: number }

const arch = (label: string, inchesPerFoot: number): ScalePreset => ({ label: `${label} = 1'-0"`, pointsPerFoot: inchesPerFoot * 72 })
const eng = (n: number): ScalePreset => ({ label: `1" = ${n}'`, pointsPerFoot: 72 / n })

export const SCALE_PRESETS: ScalePreset[] = [
  arch('1/16"', 1 / 16), arch('3/32"', 3 / 32), arch('1/8"', 1 / 8), arch('3/16"', 3 / 16),
  arch('1/4"', 1 / 4), arch('3/8"', 3 / 8), arch('1/2"', 1 / 2), arch('3/4"', 3 / 4),
  arch('1"', 1), arch('1-1/2"', 1.5), arch('3"', 3),
  ...[10, 20, 30, 40, 50, 60, 100].map(eng),
]

// ---- Per-markup measurement ----

/** Radius markup: points are [cx, cy, ex, ey] (center, then a point on the circle). */
export const radiusOf = (points: number[]): number =>
  points.length >= 4 ? Math.hypot(points[2] - points[0], points[3] - points[1]) : 0

export interface CircleStats { radius: number; diameter: number; area: number }
/** Radius (ft), diameter (ft) and area (SF) of a radius markup at the given scale. */
export function circleStats(points: number[], ppf: number): CircleStats {
  const radius = radiusOf(points) / ppf
  return { radius, diameter: radius * 2, area: Math.PI * radius * radius }
}
/** `R 4'-6"` */
export const formatRadius = (feet: number) => `R ${formatFeetInches(feet)}`

export const LENGTH_TYPES: string[] = ['measure-length', 'measure-polylength']

export const feetOf = (points: number[], ppf: number) => polylineLength(points) / ppf
export const sqftOf = (points: number[], ppf: number) => polygonArea(points) / (ppf * ppf)

export interface MeasureTotal { key: string; label: string; color: string; value: string; ids: string[] }
export interface MeasureSummary {
  length: MeasureTotal[]; lengthTotal: string
  area: MeasureTotal[]; areaTotal: string
  cable: MeasureTotal[]; cableTotal: string
  radius: MeasureTotal[]
  count: MeasureTotal[]
  unscaled: number
}

function group(markups: Markup[], types: string[], val: (pts: number[]) => number, fmt: (v: number) => string, label: string) {
  const map = new Map<string, { color: string; v: number; ids: string[] }>()
  let total = 0
  for (const m of markups) {
    if (!types.includes(m.type) || !('points' in m.geometry)) continue
    const v = val(m.geometry.points)
    const color = m.style.stroke || '#e03131'
    const e = map.get(color) ?? { color, v: 0, ids: [] }
    e.v += v
    e.ids.push(m.id)
    map.set(color, e)
    total += v
  }
  const rows: MeasureTotal[] = [...map.values()].map(e => ({ key: `${label}${e.color}`, label, color: e.color, value: fmt(e.v), ids: e.ids }))
  return { rows, total: fmt(total) }
}

/** Totals for one page's markups, grouped by type then stroke color. */
export function summarize(markups: Markup[], ppf: number | null): MeasureSummary {
  const out: MeasureSummary = { length: [], lengthTotal: '', area: [], areaTotal: '', cable: [], cableTotal: '', radius: [], count: [], unscaled: 0 }
  if (ppf) {
    const l = group(markups, LENGTH_TYPES, p => feetOf(p, ppf), formatFeetInches, 'Length')
    const a = group(markups, ['measure-area'], p => sqftOf(p, ppf), formatArea, 'Area')
    const c = group(markups, ['cable'], p => feetOf(p, ppf), formatFeetInches, 'Cable')
    out.radius = markups.filter(m => m.type === 'measure-radius' && 'points' in m.geometry)
      .map(m => ({ key: m.id, label: 'Radius', color: m.style.stroke || '#e03131', value: formatRadius(circleStats((m.geometry as PathGeometry).points, ppf).radius), ids: [m.id] }))
    Object.assign(out, { length: l.rows, lengthTotal: l.total, area: a.rows, areaTotal: a.total, cable: c.rows, cableTotal: c.total })
  } else {
    out.unscaled = markups.filter(m => [...LENGTH_TYPES, 'measure-area', 'measure-radius', 'cable'].includes(m.type)).length
  }
  const groups = new Map<string, { color: string; n: number; ids: string[] }>()
  for (const m of markups) {
    if (m.type !== 'count') continue
    const color = m.style.stroke || '#e03131'
    const key = `${String(m.fields?.group ?? 'none')}|${color}`
    const e = groups.get(key) ?? { color, n: 0, ids: [] }
    e.n++
    e.ids.push(m.id)
    groups.set(key, e)
  }
  let i = 0
  out.count = [...groups.entries()].map(([key, e]) => ({ key, label: `Count ${++i}`, color: e.color, value: String(e.n), ids: e.ids }))
  return out
}
