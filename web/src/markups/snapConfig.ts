// Snap settings: which sources snap, the grid, and the master switch. Stored in the user's prefs (see prefs/prefs.ts).

export interface SnapSettings {
  /** Master switch (hotkey snap.toggle). Off = nothing snaps and nothing aligns. */
  on: boolean
  grid: boolean
  /** PDF lines extracted from the plan. */
  pdf: boolean
  /** Vertices, midpoints and edges of other markups. */
  markups: boolean
  /** Centres of devices. */
  devices: boolean
  /** Phase 6: devices and boxes turn to the line they snap to. */
  align: boolean
  /** Draw the grid when it is wide enough to read. */
  showGrid: boolean
  /** Grid spacing in feet when the page has a scale. */
  gridFeet: number
  /** Grid spacing in points when it has none. */
  gridPoints: number
}

export const DEFAULT_SNAP: SnapSettings = {
  on: true, grid: false, pdf: true, markups: true, devices: true, align: true, showGrid: false, gridFeet: 1, gridPoints: 12,
}

export const SNAP_RADIUS_PX = 8
export const GRID_MIN = 0.01
export const GRID_MAX = 1000

const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) && v >= GRID_MIN && v <= GRID_MAX ? v : d)

/** Accepts anything (old versions, hand-edited) and returns well-formed settings. */
export function normalizeSnap(raw: unknown): SnapSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const b = (k: keyof SnapSettings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (DEFAULT_SNAP[k] as boolean))
  return {
    on: b('on'), grid: b('grid'), pdf: b('pdf'), markups: b('markups'), devices: b('devices'), align: b('align'), showGrid: b('showGrid'),
    gridFeet: num(r.gridFeet, DEFAULT_SNAP.gridFeet), gridPoints: num(r.gridPoints, DEFAULT_SNAP.gridPoints),
  }
}

/** Grid step in page points: feet times points_per_foot when the page is scaled, else the point spacing. */
export function gridStep(s: SnapSettings, pointsPerFoot: number | null): number {
  return pointsPerFoot && pointsPerFoot > 0 ? s.gridFeet * pointsPerFoot : s.gridPoints
}

/** Below this many screen pixels between grid lines the grid is not drawn. */
export const GRID_DRAW_MIN_PX = 6
/** Below this many screen pixels between grid points snapping to them is pointless. */
export const GRID_SNAP_MIN_PX = 3
