import { deviceCenter } from './geometry'
import type { BoxGeometry, Markup } from './types'
import type { Change } from './useMarkups'

export const DEVICE_SCALE_MIN = 0.25
export const DEVICE_SCALE_MAX = 4
export const DEVICE_SCALE_STEP = 0.05

/** A usable device size multiplier: finite, within range, rounded to 1%. Anything else is 1. */
export function clampDeviceScale(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.round(Math.min(DEVICE_SCALE_MAX, Math.max(DEVICE_SCALE_MIN, n)) * 100) / 100
}

/** The same box scaled by `f` about its center (rotation aware); coverage (fov) is left alone. */
export function scaleBox(g: BoxGeometry, f: number): BoxGeometry {
  if (f === 1) return g
  const c = deviceCenter(g)
  const w = g.width * f, h = g.height * f
  const a = (g.rotation * Math.PI) / 180
  return { ...g, width: w, height: h,
    x: c.x - ((w / 2) * Math.cos(a) - (h / 2) * Math.sin(a)),
    y: c.y - ((w / 2) * Math.sin(a) + (h / 2) * Math.cos(a)) }
}

/** Device markups as drawn at multiplier `f`; everything else (and f = 1) is returned untouched. */
export function scaleDevice(m: Markup, f: number): Markup {
  if (f === 1 || m.type !== 'device' || !('width' in m.geometry)) return m
  return { ...m, geometry: scaleBox(m.geometry, f) }
}

export function scaleDevices(ms: Iterable<Markup>, f: number): Markup[] {
  const list = [...ms]
  return f === 1 ? list : list.map(m => scaleDevice(m, f))
}

/**
 * Turns a change made on scaled (on-screen) devices back into stored geometry. A size that was not
 * edited keeps its exact stored width and height, so moving a device never rewrites its size.
 * `stored` looks up the real markup for a `before` (kept as is, so undo restores it exactly).
 */
export function unscaleChange(change: Change, f: number, stored?: (id: string) => Markup | undefined): Change {
  if (f === 1) return change
  const isBox = (m: Markup | null): m is Markup => !!m && m.type === 'device' && 'width' in m.geometry
  return change.map(({ before, after }) => {
    const real = isBox(before) ? (stored?.(before.id) ?? scaleDevice(before, 1 / f)) : before
    if (!isBox(after)) return { before: real, after }
    const g = scaleBox(after.geometry as BoxGeometry, 1 / f)
    const shown = isBox(before) ? before.geometry as BoxGeometry : null
    const rg = isBox(real) ? real.geometry as BoxGeometry : null
    const ag = after.geometry as BoxGeometry
    const same = (a: number, c: number) => Math.abs(a - c) < 1e-6
    const keepSize = shown && rg && same(ag.width, shown.width) && same(ag.height, shown.height)
    return { before: real, after: { ...after, geometry: keepSize ? { ...g, width: rg.width, height: rg.height } : g } }
  })
}
