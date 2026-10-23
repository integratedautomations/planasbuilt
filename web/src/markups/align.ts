// Phase 6: turning devices and boxes to the line they snapped to. Pure math; the canvas decides when to call it.
import type { BoxGeometry } from './types'
import type { Pt } from './geometry'
import { SQUARE_HALF, WALL_FLAT, resolveMount } from './mount'
import type { Mount } from './mount'
import { faceAngle, norm180 } from './placeRotate'
import { cornerBisector } from './snap'
import type { SnapHit } from './snap'

const round2 = (v: number) => Math.round(v * 100) / 100

/** Box types that turn to a line they are dropped on (devices are handled separately). */
export const ALIGN_BOX_TYPES: ReadonlySet<string> = new Set(['rect', 'text', 'cloud', 'stamp'])

/** Snaps with a direction that a device may turn to. */
export const alignable = (hit: SnapHit | null | undefined): hit is SnapHit & { angle: number } =>
  !!hit && hit.angle !== undefined && (hit.kind === 'pdf' || hit.kind === 'edge' || hit.kind === 'midpoint' || (hit.kind === 'endpoint' && !!hit.corner))

/** The geometry with its centre moved to `c` (rotation is about the top-left, so turning a box moves its centre). */
export function withCenter(g: BoxGeometry, c: Pt): BoxGeometry {
  const a = (g.rotation * Math.PI) / 180
  const cx = g.width / 2, cy = g.height / 2
  return { ...g, x: round2(c.x - (cx * Math.cos(a) - cy * Math.sin(a))), y: round2(c.y - (cx * Math.sin(a) + cy * Math.cos(a))) }
}

/** Direction (page degrees) of the normal to a line at `lineDeg`, on the side of `side` seen from `on` (a point on the line). */
export function normalToward(lineDeg: number, on: Pt, side: Pt): number {
  const n = lineDeg + 90
  const a = (n * Math.PI) / 180
  const dot = (side.x - on.x) * Math.cos(a) + (side.y - on.y) * Math.sin(a)
  return norm180(dot >= 0 ? n : n + 180)
}

/**
 * A device turned to a wall line. Its front (the round side of a wall "D", or the coverage direction) points away
 * from the line toward the side `pointer` is on; a wall D is also pushed back so its flat side lies on the line.
 * `hit.point` is the snapped point on the line. Free (unlocked) coverage turns; otherwise the device itself does.
 * At a wall corner (`hit.corner`) the device is corner-mounted: its front (and coverage) points along the corner's bisector into the
 * open side, and a wall D sits with its flat side across the corner.
 */
export function alignDevice(g: BoxGeometry, hit: SnapHit & { angle: number }, pointer: Pt, mount: Mount | string | null | undefined): BoxGeometry {
  const facing = hit.corner ? cornerBisector(hit.corner) : normalToward(hit.angle, hit.point, pointer)
  const r = Math.min(g.width, g.height) / 2
  const m = resolveMount(mount, g.mount)
  if (m === 'square') return alignSquare(g, hit, facing, r)
  const turned = faceAngle(g, facing)
  const back = m === 'wall' ? WALL_FLAT * r : 0
  const a = (facing * Math.PI) / 180
  return withCenter(turned, { x: hit.point.x + Math.cos(a) * back, y: hit.point.y + Math.sin(a) * back })
}

/**
 * A square (panel / box) device on a wall: one side lies flat on the line, not its centre. At a corner it sits in the corner
 * with a side on each wall (its centre on the bisector, half a side from both walls). Free coverage still points `facing`.
 */
function alignSquare(g: BoxGeometry, hit: SnapHit & { angle: number }, facing: number, r: number): BoxGeometry {
  const h = SQUARE_HALF * r
  const wallDeg = hit.corner ? hit.corner.a : hit.angle
  let back = h
  if (hit.corner) {
    const span = (((hit.corner.b - hit.corner.a) % 360) + 360) % 360
    back = h / Math.max(0.2, Math.sin((span * Math.PI) / 360))
  }
  let out: BoxGeometry = { ...g, rotation: nearestSideRotation(g.rotation || 0, wallDeg) }
  if (g.fov && !g.fov.locked) out = { ...out, fov: { ...g.fov, direction: Math.round(facing * 100) / 100 } }
  const a = (facing * Math.PI) / 180
  return withCenter(out, { x: hit.point.x + Math.cos(a) * back, y: hit.point.y + Math.sin(a) * back })
}

/** Rotation among `lineDeg + k * 90` closest to `current` (a rectangle's sides may sit on the line with either pair). */
export function nearestSideRotation(current: number, lineDeg: number): number {
  let best = lineDeg, bd = Infinity
  for (let k = -4; k <= 4; k++) {
    const cand = lineDeg + k * 90
    const d = Math.abs(norm180(cand - current))
    if (d < bd) { bd = d; best = cand }
  }
  return round2(((best % 360) + 360) % 360)
}

/** A box turned about `pivot` (a corner or centre that snapped onto the line) so a side runs along the line. */
export function alignBox(g: BoxGeometry, pivot: Pt, lineDeg: number): BoxGeometry {
  const rotation = nearestSideRotation(g.rotation, lineDeg)
  const d = ((rotation - g.rotation) * Math.PI) / 180
  const cos = Math.cos(d), sin = Math.sin(d)
  const ox = g.x - pivot.x, oy = g.y - pivot.y
  return { ...g, rotation, x: round2(pivot.x + ox * cos - oy * sin), y: round2(pivot.y + ox * sin + oy * cos) }
}

/** Free rotation snaps to 0, 90, 180 and 270 degrees when within `tol`. */
export function snapRotation(deg: number, tol = 5): number {
  const q = Math.round(deg / 90) * 90
  return Math.abs(deg - q) <= tol ? ((q % 360) + 360) % 360 : deg
}

/**
 * A box drawn from corner `a` to `b` in a frame turned by `theta` degrees (the line the first corner snapped to), so its
 * sides run along that line. `square` forces equal sides.
 */
export function boxFromDragAligned(a: Pt, b: Pt, theta: number, square = false): BoxGeometry {
  const rad = (theta * Math.PI) / 180
  const ux = Math.cos(rad), uy = Math.sin(rad), vx = -uy, vy = ux
  let w = (b.x - a.x) * ux + (b.y - a.y) * uy
  let h = (b.x - a.x) * vx + (b.y - a.y) * vy
  if (square) {
    const s = Math.max(Math.abs(w), Math.abs(h))
    w = Math.sign(w || 1) * s
    h = Math.sign(h || 1) * s
  }
  const x0 = Math.min(0, w), y0 = Math.min(0, h)
  return { x: round2(a.x + ux * x0 + vx * y0), y: round2(a.y + uy * x0 + vy * y0), width: Math.abs(w), height: Math.abs(h), rotation: round2(((theta % 360) + 360) % 360) }
}
