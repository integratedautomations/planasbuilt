// Length and area formatting, shared by the canvas, totals, exports, reports and the Devices page.
// The unit style comes from the signed-in user's prefs (see prefs/store.ts, which calls setUnits), so
// exports use the exporting user's choice. Defaults: feet-inches rounded to 1/2".

export type UnitMode = 'ftin' | 'decimal'
/** Rounding as the denominator of an inch: 1 = nearest inch, 2 = 1/2", 4 = 1/4". */
export type UnitRound = 1 | 2 | 4

export interface UnitsPrefs { mode: UnitMode; round: UnitRound }

export const UNIT_MODES: UnitMode[] = ['ftin', 'decimal']
export const UNIT_ROUNDS: UnitRound[] = [1, 2, 4]
export const DEFAULT_UNITS: UnitsPrefs = { mode: 'ftin', round: 2 }

/** Accepts anything (old versions, hand-edited) and returns well-formed settings. */
export function normalizeUnits(raw: unknown): UnitsPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    mode: r.mode === 'ftin' || r.mode === 'decimal' ? r.mode : DEFAULT_UNITS.mode,
    round: r.round === 1 || r.round === 2 || r.round === 4 ? r.round : DEFAULT_UNITS.round,
  }
}

let current: UnitsPrefs = DEFAULT_UNITS
/** Called by the prefs store whenever the user's units change. */
export function setUnits(u: UnitsPrefs) { current = normalizeUnits(u) }
export const getUnits = (): UnitsPrefs => current

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** `12'-6 1/2"` (ft-in, rounded to the chosen fraction) or `12.54 ft` (decimal). */
export function formatLength(feet: number, units: UnitsPrefs = current): string {
  const f = Math.max(0, Number.isFinite(feet) ? feet : 0)
  if (units.mode === 'decimal') {
    const step = 12 * units.round // rounding steps per foot
    return `${(Math.round(f * step) / step).toFixed(2)} ft`
  }
  const den = units.round
  const total = Math.round(f * 12 * den) // in 1/den inches
  const perFoot = 12 * den
  const ft = Math.floor(total / perFoot)
  const rem = total % perFoot
  const whole = Math.floor(rem / den)
  const n = rem % den
  let inches = String(whole)
  if (n > 0) {
    const g = gcd(n, den)
    const frac = `${n / g}/${den / g}`
    inches = whole > 0 ? `${whole} ${frac}` : frac
  }
  return `${ft}'-${inches}"`
}

/** `1,234.5 SF` */
export function formatArea(sqft: number): string {
  return `${sqft.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} SF`
}
