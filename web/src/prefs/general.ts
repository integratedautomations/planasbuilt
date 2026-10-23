// General per-user options from the Preferences page (placing, viewing, touch). Stored as one object in the user's prefs.

export type AfterPlace = 'stay' | 'select'
export type LabelMode = 'always' | 'zoomed' | 'never'
export type OpenAt = 'fit' | 'last'
export type PencilMode = 'box' | 'draw'
/** Hold-to-rotate snap step in degrees; 0 = free rotation. */
export type RotateStep = 15 | 5 | 0

export interface GeneralPrefs {
  /** After placing a device: keep the device tool, or go back to Select. */
  afterPlace: AfterPlace
  rotateStep: RotateStep
  /** Ask before deleting more than one markup at once. */
  confirmMultiDelete: boolean
  labels: LabelMode
  /** Coverage cones shown on projects where the user has not toggled them. */
  coverageDefault: boolean
  /** Coverage fill opacity (0.05 to 0.6) for cones that have no opacity of their own; null = built-in default. */
  coverageOpacity: number | null
  showCursors: boolean
  showViewRects: boolean
  showSelections: boolean
  /** Wheel zoom speed multiplier. */
  wheelSpeed: number
  middlePan: boolean
  openAt: OpenAt
  /** Touch long-press time (ms) for the context menu. */
  longPressMs: number
  /** Apple Pencil on empty space: drag a selection box, or draw (pan like a mouse). */
  pencil: PencilMode
  haptics: boolean
}

export const DEFAULT_GENERAL: GeneralPrefs = {
  afterPlace: 'stay', rotateStep: 15, confirmMultiDelete: false, labels: 'always',
  coverageDefault: true, coverageOpacity: null, showCursors: true, showViewRects: true, showSelections: true,
  wheelSpeed: 1, middlePan: true, openAt: 'fit', longPressMs: 500, pencil: 'box', haptics: true,
}

export const WHEEL_SPEED_MIN = 0.25, WHEEL_SPEED_MAX = 4
export const LONG_PRESS_MIN = 250, LONG_PRESS_MAX = 1200
export const COVERAGE_OPACITY_MIN = 0.05, COVERAGE_OPACITY_MAX = 0.6

const oneOf = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const inRange = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d)

/** Accepts anything (old versions, hand-edited, null) and returns well-formed options; missing ones take the defaults. */
export function normalizeGeneral(raw: unknown): GeneralPrefs {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const D = DEFAULT_GENERAL
  const op = inRange(r.coverageOpacity, COVERAGE_OPACITY_MIN, COVERAGE_OPACITY_MAX, -1)
  return {
    afterPlace: oneOf(r.afterPlace, ['stay', 'select'], D.afterPlace),
    rotateStep: oneOf(r.rotateStep, [15, 5, 0], D.rotateStep),
    confirmMultiDelete: bool(r.confirmMultiDelete, D.confirmMultiDelete),
    labels: oneOf(r.labels, ['always', 'zoomed', 'never'], D.labels),
    coverageDefault: bool(r.coverageDefault, D.coverageDefault),
    coverageOpacity: op < 0 ? null : op,
    showCursors: bool(r.showCursors, D.showCursors),
    showViewRects: bool(r.showViewRects, D.showViewRects),
    showSelections: bool(r.showSelections, D.showSelections),
    wheelSpeed: inRange(r.wheelSpeed, WHEEL_SPEED_MIN, WHEEL_SPEED_MAX, D.wheelSpeed),
    middlePan: bool(r.middlePan, D.middlePan),
    openAt: oneOf(r.openAt, ['fit', 'last'], D.openAt),
    longPressMs: Math.round(inRange(r.longPressMs, LONG_PRESS_MIN, LONG_PRESS_MAX, D.longPressMs)),
    pencil: oneOf(r.pencil, ['box', 'draw'], D.pencil),
    haptics: bool(r.haptics, D.haptics),
  }
}

/** Labels at this zoom or above show in "only when zoomed in" mode. */
export const LABEL_MIN_ZOOM = 0.6
export const labelVisible = (mode: LabelMode, zoom: number): boolean => mode === 'always' || (mode === 'zoomed' && zoom >= LABEL_MIN_ZOOM)

/** Short vibration where the device supports it; never throws. */
export function haptic(on: boolean, ms = 12) {
  if (!on) return
  try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms) } catch { /* unsupported */ }
}
