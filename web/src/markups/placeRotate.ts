import type { BoxGeometry } from './types'

/** Pointer travel (screen px) after which a held placement starts rotating the device instead of just placing it. */
export const PLACE_ROTATE_SLOP_PX = 6
export const PLACE_SNAP_STEP = 15
/** The round side of a wall device faces up (-90) in the device's own frame when it has no coverage. */
const FRONT_IN_FRAME = -90

/** Normalizes degrees to (-180, 180] without rounding. */
export function norm180(d: number): number {
  const r = ((d % 360) + 360) % 360
  return r > 180 ? r - 360 : r
}

/** Direction in degrees (0 = right, 90 = down, like the page) from `from` to `to`; null when they coincide. */
export function angleFromTo(from: { x: number; y: number }, to: { x: number; y: number }): number | null {
  const dx = to.x - from.x, dy = to.y - from.y
  if (Math.hypot(dx, dy) < 1e-9) return null
  return norm180((Math.atan2(dy, dx) * 180) / Math.PI)
}

/** Rounds to the nearest `step` degrees (default 15); the result is in (-180, 180]. */
export function snapAngle(deg: number, step = PLACE_SNAP_STEP): number {
  return norm180(Math.round(deg / step) * step)
}

/** True when a held placement should turn the device's coverage (it has some and it is not locked) rather than the device itself. */
export function rotatesCoverage(g: BoxGeometry): boolean {
  return !!g.fov && !g.fov.locked
}

/**
 * The geometry turned so the device faces `angle` (page degrees, 0 = right, 90 = down).
 * With free coverage the cone's absolute direction is set and the device rotation is kept; otherwise
 * (no coverage, or locked coverage) the device rotation is set so its front (up in its own frame,
 * the round side of a wall "D") points at `angle`.
 */
export function faceAngle(g: BoxGeometry, angle: number): BoxGeometry {
  if (g.fov && !g.fov.locked) return { ...g, fov: { ...g.fov, direction: Math.round(angle * 100) / 100 } }
  const rotation = ((angle - FRONT_IN_FRAME) % 360 + 360) % 360
  return { ...g, rotation: Math.round(rotation * 100) / 100 }
}

/** Angle (page degrees) from a device centre to the pointer, snapped to 15 degrees unless `free`; null when the pointer is on the centre. */
export function placeAngle(center: { x: number; y: number }, pointer: { x: number; y: number }, free: boolean): number | null {
  const a = angleFromTo(center, pointer)
  if (a === null) return null
  return free ? a : snapAngle(a)
}

/** Label for the live angle readout: 0 to 359 degrees clockwise from the right. */
export function angleLabel(angle: number): string {
  return `${Math.round(((angle % 360) + 360) % 360) % 360}\u00b0`
}
