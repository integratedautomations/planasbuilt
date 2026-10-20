import { formatFeetInches, parseFeetInches } from './measure'
import type { Fov, SymbolSet } from './types'

/** A device type's default coverage (stored on the type; range in feet). */
export interface CoverageDefault { on: boolean; angle: number; range_ft: number }

export const COVERAGE_DEFAULT_PX: Fov = { direction: -90, angle: 90, range: 150 }
export const COVERAGE_OPACITY = 0.18
export const MIN_RANGE_PX = 10

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const clampAngle = (a: number) => clamp(Math.round(a), 1, 360)
/** Normalizes a rotation to (-180, 180]. */
export function normDeg(d: number): number {
  const r = ((d % 360) + 360) % 360
  return Math.round(r > 180 ? r - 360 : r)
}

/** Drawn range in page points: real feet x scale when both are known, otherwise the stored px. */
export function rangePx(fov: Fov, ppf: number | null): number {
  return fov.rangeFt !== undefined && ppf ? fov.rangeFt * ppf : fov.range
}
/** Range in feet, or null when there is no scale to convert with. */
export function rangeFeet(fov: Fov, ppf: number | null): number | null {
  if (fov.rangeFt !== undefined) return fov.rangeFt
  return ppf ? fov.range / ppf : null
}
/** Sets the range from page points; with a scale also records the real length. */
export function withRangePx(fov: Fov, px: number, ppf: number | null): Fov {
  const range = Math.max(MIN_RANGE_PX, px)
  const out: Fov = { ...fov, range }
  if (ppf) out.rangeFt = range / ppf
  else delete out.rangeFt
  return out
}
/** Sets the range from feet (needs a scale for the px fallback). */
export function withRangeFeet(fov: Fov, feet: number, ppf: number | null): Fov {
  const ft = Math.max(0.1, feet)
  return { ...fov, rangeFt: ft, range: Math.max(MIN_RANGE_PX, ppf ? ft * ppf : fov.range) }
}
export const formatRange = (feet: number) => formatFeetInches(feet)
/** Parses a typed length ("40'", "40", "12'-6\"") into feet; null if invalid or not positive. */
export function parseRange(text: string): number | null {
  const v = parseFeetInches(text)
  return v !== null && v > 0 ? v : null
}

/** A new device's coverage: the set's legacy camera cone, else the device type's default. */
export function initialCoverage(set: SymbolSet | undefined, def: CoverageDefault | null | undefined, ppf: number | null): Fov | undefined {
  if (def?.on) {
    const angle = clampAngle(def.angle || 90)
    const ft = def.range_ft > 0 ? def.range_ft : 20
    return ppf
      ? { direction: -90, angle, range: Math.max(MIN_RANGE_PX, ft * ppf), rangeFt: ft }
      : { direction: -90, angle, range: Math.max(MIN_RANGE_PX, ft * 7.5), rangeFt: ft }
  }
  return set?.has_fov ? { ...COVERAGE_DEFAULT_PX } : undefined
}

/** Sector outline relative to the center: apex, then arc points (a full circle has no apex spoke). Angles in degrees. */
export function sectorPoints(range: number, angle: number, direction: number, steps?: number): number[] {
  const n = steps ?? Math.max(4, Math.ceil(angle / 8))
  const a0 = ((direction - angle / 2) * Math.PI) / 180, a1 = ((direction + angle / 2) * Math.PI) / 180
  const out: number[] = angle >= 360 ? [] : [0, 0]
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push(range * Math.cos(a), range * Math.sin(a))
  }
  return out
}

/** Sector area in square points (angle in degrees). */
export const sectorArea = (range: number, angle: number) => (Math.PI * range * range * Math.min(360, angle)) / 360

/** Coverage is shown when a device has it and it is not switched off. */
export const hasCoverage = (fov: Fov | undefined): fov is Fov => !!fov && !fov.hidden
