import { describe, expect, it } from 'vitest'
import { clampDeviceScale, scaleBox, scaleDevice, scaleDevices, unscaleChange } from './deviceScale'
import { deviceCenter } from './geometry'
import type { Markup } from './types'

const base = { document_id: 'doc', page: 1, symbol_set_id: 'fa', tag: '', style: { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }, text: '', layer_id: null }
const mk = (type: any, geometry: any): Markup => ({ ...base, id: 'd1', type, geometry })

const dev = (x: number, y: number, w: number, h: number, rotation = 0) =>
  mk('device', { x, y, width: w, height: h, rotation })

describe('device size', () => {
  it('clamps and rounds the multiplier', () => {
    expect(clampDeviceScale(1)).toBe(1)
    expect(clampDeviceScale(0.1)).toBe(0.25)
    expect(clampDeviceScale(9)).toBe(4)
    expect(clampDeviceScale(1.2549)).toBe(1.25)
    expect(clampDeviceScale('x')).toBe(1)
    expect(clampDeviceScale(NaN)).toBe(1)
    expect(clampDeviceScale(-2)).toBe(1)
  })

  it('scales about the center, also when rotated', () => {
    for (const rot of [0, 30, 90]) {
      const g = dev(100, 50, 24, 24, rot).geometry as any
      const s = scaleBox(g, 2)
      expect(s.width).toBe(48)
      const c0 = deviceCenter(g), c1 = deviceCenter(s)
      expect(c1.x).toBeCloseTo(c0.x, 9)
      expect(c1.y).toBeCloseTo(c0.y, 9)
    }
  })

  it('leaves 1.0, non-devices and coverage alone', () => {
    const d = dev(10, 10, 24, 24)
    expect(scaleDevice(d, 1)).toBe(d)
    const r = mk('rect', { x: 0, y: 0, width: 10, height: 10, rotation: 0 })
    expect(scaleDevice(r, 2)).toBe(r)
    const fov = { direction: 0, angle: 90, range: 40, rangeUnit: 'ft' } as any
    const withFov = { ...d, geometry: { ...d.geometry, fov } } as any
    expect((scaleDevice(withFov, 2).geometry as any).fov).toBe(fov)
    expect(scaleDevices([d], 1)[0]).toBe(d)
  })

  it('maps an edit back to stored geometry without touching the size on a move', () => {
    const d = dev(100, 100, 24, 24)
    const shown = scaleDevice(d, 1.5)
    const moved = { ...shown, geometry: { ...(shown.geometry as any), x: (shown.geometry as any).x + 30 } }
    const [c] = unscaleChange([{ before: shown, after: moved }], 1.5)
    const g = c.after!.geometry as any
    expect(g.width).toBe(24)
    expect(g.height).toBe(24)
    expect(g.x).toBeCloseTo(130, 9)
  })

  it('divides a resize and new placements by the factor', () => {
    const shown = scaleDevice(dev(100, 100, 24, 24), 2)
    const resized = { ...shown, geometry: { ...(shown.geometry as any), width: 96, height: 96 } }
    const [c] = unscaleChange([{ before: shown, after: resized }], 2)
    expect((c.after!.geometry as any).width).toBeCloseTo(48, 9)
    const [n] = unscaleChange([{ before: null, after: dev(0, 0, 48, 48) }], 2)
    expect((n.after!.geometry as any).width).toBeCloseTo(24, 9)
  })
})
