import type { Fov, Markup } from './types'

/**
 * How a device is mounted, shown by the shape of its container:
 *   ceiling = circle, wall = a "D" whose flat side is the wall, square = rounded square (panels, equipment, wall boxes).
 * A device type has a default; a placed device may override it (null/absent = the type's default).
 */
export type Mount = 'ceiling' | 'wall' | 'square'

export const DEFAULT_MOUNT: Mount = 'ceiling'

export const MOUNTS: { value: Mount; label: string; hint: string }[] = [
  { value: 'ceiling', label: 'Ceiling', hint: 'Circle' },
  { value: 'wall', label: 'Wall', hint: 'Flat side on the wall' },
  { value: 'square', label: 'Square', hint: 'Panel, equipment or wall box' },
]

export const isMount = (v: unknown): v is Mount => v === 'ceiling' || v === 'wall' || v === 'square'

export const mountLabel = (m: Mount) => MOUNTS.find(x => x.value === m)?.label ?? 'Ceiling'

/** The mount a device is drawn with: its own override, else its type's default, else ceiling. Invalid values are ignored. */
export function resolveMount(typeMount: unknown, override: unknown): Mount {
  if (isMount(override)) return override
  if (isMount(typeMount)) return typeMount
  return DEFAULT_MOUNT
}

/** The markup with its mount override set (a valid mount) or cleared (anything else = use the type's default). Non-box markups are returned as is. */
export function withMount(m: Markup, mount: string | null): Markup {
  if (!('width' in m.geometry)) return m
  const geometry = { ...m.geometry }
  if (isMount(mount)) geometry.mount = mount; else delete geometry.mount
  return { ...m, geometry }
}

// ---- Geometry (all lengths in units of the disc radius r; y points down like the page)

/** Wall "D": the flat side sits this far behind the centre; the round side reaches r in front. */
export const WALL_FLAT = 0.45
/** Square: half side and corner radius, giving about the same area as the circle (pi r^2 = (2 * 0.89 r)^2 within 1%). */
export const SQUARE_HALF = 0.89
export const SQUARE_CORNER = 0.2

/** The icon is drawn in a 24x24 box (see classIcons.ts). On the circle and the square it is 1.24 r wide. */
export const ICON_BOX = 24
export const ICON_SIZE = 1.24
/** On the wall D the icon is smaller (so it fits for any facing) and sits toward the middle of the D. */
export const WALL_ICON_SIZE = 0.96

/**
 * Artwork that stays inside this square of the 24x24 icon box fits inside all three shapes, at any wall
 * facing, with room for the white outline ring.
 */
export const SAFE_AREA = { min: 3, max: 21 } as const

const norm180 = (d: number) => { const m = ((d % 360) + 360) % 360; return m > 180 ? m - 360 : m }

/** Direction (degrees, 0 = right, 90 = down) in the device's own, rotated frame that the round side of a wall device points to. */
export function wallFacing(g: { rotation?: number; fov?: Fov }): number {
  const rot = g.rotation || 0
  // With coverage the device faces where the coverage points; the flat side is the opposite one. Otherwise the flat side is down (the back).
  return g.fov ? norm180(g.fov.direction - rot) : -90
}

export interface MountShape {
  mount: Mount
  /** Closed outline around the centre: x0, y0, x1, y1, ... (scaled by r). */
  outline: number[]
  /** Icon box: centre offset from the shape centre and side length. */
  icon: { cx: number; cy: number; size: number }
}

const rot = (pts: number[], deg: number): number[] => {
  if (!deg) return pts
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const out: number[] = []
  for (let i = 0; i + 1 < pts.length; i += 2) out.push(pts[i] * c - pts[i + 1] * s, pts[i] * s + pts[i + 1] * c)
  return out
}

function circlePoints(r: number, steps = 48): number[] {
  const out: number[] = []
  for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; out.push(Math.cos(a) * r, Math.sin(a) * r) }
  return out
}

function wallPoints(r: number, steps = 40): number[] {
  const t = Math.acos(-WALL_FLAT) // arc runs from -t to +t through the front (angle 0)
  const out: number[] = []
  for (let i = 0; i <= steps; i++) { const a = -t + (2 * t * i) / steps; out.push(Math.cos(a) * r, Math.sin(a) * r) }
  return out // the chord from the last point back to the first is the flat side
}

function squarePoints(r: number, perCorner = 6): number[] {
  const h = SQUARE_HALF * r, k = SQUARE_CORNER * r
  const out: number[] = []
  // corner centres, clockwise from top-right (y down)
  const corners: [number, number, number][] = [[h - k, -(h - k), -90], [h - k, h - k, 0], [-(h - k), h - k, 90], [-(h - k), -(h - k), 180]]
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const a = ((start + (90 * i) / perCorner) * Math.PI) / 180
      out.push(cx + Math.cos(a) * k, cy + Math.sin(a) * k)
    }
  }
  return out
}

/** Outline and icon placement of a mount at disc radius `r`. `facing` only matters for 'wall' (see wallFacing). */
export function mountShape(mount: Mount, r: number, facing = -90): MountShape {
  if (mount === 'wall') {
    const off = ((1 - WALL_FLAT) / 2) * r // the D spans -WALL_FLAT r .. r along its facing, so its middle is here
    const a = (facing * Math.PI) / 180
    return { mount, outline: rot(wallPoints(r), facing),
      icon: { cx: Math.cos(a) * off, cy: Math.sin(a) * off, size: WALL_ICON_SIZE * r } }
  }
  if (mount === 'square') return { mount, outline: squarePoints(r), icon: { cx: 0, cy: 0, size: ICON_SIZE * r } }
  return { mount: 'ceiling', outline: circlePoints(r), icon: { cx: 0, cy: 0, size: ICON_SIZE * r } }
}

/** The outline shifted to (cx, cy). */
export function outlineAt(shape: MountShape, cx: number, cy: number): number[] {
  return shape.outline.map((v, i) => v + (i % 2 ? cy : cx))
}

/** Top-left corner and side of the icon box, relative to the shape centre. */
export function iconRect(shape: MountShape): { x: number; y: number; size: number } {
  const { cx, cy, size } = shape.icon
  return { x: cx - size / 2, y: cy - size / 2, size }
}

/** Where the 24x24 safe area (SAFE_AREA) lands relative to the shape centre: the four corners. */
export function safeCorners(shape: MountShape): [number, number][] {
  const { x, y, size } = iconRect(shape)
  const k = size / ICON_BOX
  const lo = SAFE_AREA.min * k, hi = SAFE_AREA.max * k
  return [[x + lo, y + lo], [x + hi, y + lo], [x + hi, y + hi], [x + lo, y + hi]]
}
