import { describe, expect, it } from 'vitest'
import { DEFAULT_MOUNT, ICON_BOX, MOUNTS, SAFE_AREA, WALL_FLAT, iconRect, isMount, mountShape, outlineAt, resolveMount, safeCorners, wallFacing, withMount } from './mount'
import type { Mount } from './mount'
import { DEFAULT_STYLE } from './types'
import type { BoxGeometry, Markup } from './types'

const area = (p: number[]) => {
  let a = 0
  for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; a += p[i] * p[j + 1] - p[j] * p[i + 1] }
  return Math.abs(a) / 2
}
const inside = (p: number[], x: number, y: number) => {
  let c = false
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > y) !== (p[j + 1] > y) && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c
  }
  return c
}
const edgeDist = (p: number[], x: number, y: number) => {
  let best = Infinity
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length
    const dx = p[j] - p[i], dy = p[j + 1] - p[i + 1]
    const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - (p[i] + t * dx), y - (p[i + 1] + t * dy)))
  }
  return best
}

describe('mount resolution', () => {
  it('lists the three mounts and validates values', () => {
    expect(MOUNTS.map(m => m.value)).toEqual(['ceiling', 'wall', 'square'])
    expect(DEFAULT_MOUNT).toBe('ceiling')
    for (const v of ['ceiling', 'wall', 'square']) expect(isMount(v)).toBe(true)
    for (const v of ['floor', '', null, undefined, 3, {}]) expect(isMount(v)).toBe(false)
  })
  it("uses the device's override, else its type's default, else ceiling", () => {
    expect(resolveMount('wall', undefined)).toBe('wall')
    expect(resolveMount('wall', null)).toBe('wall')
    expect(resolveMount('wall', 'square')).toBe('square')
    expect(resolveMount('square', 'ceiling')).toBe('ceiling') // an explicit ceiling still overrides the type
    expect(resolveMount(undefined, undefined)).toBe('ceiling')
    expect(resolveMount(null, null)).toBe('ceiling')
  })
  it('ignores invalid values at either level', () => {
    expect(resolveMount('sideways', 'wall')).toBe('wall')
    expect(resolveMount('wall', 'sideways')).toBe('wall')
    expect(resolveMount('x', 'y')).toBe('ceiling')
  })
})

describe('per-device override', () => {
  const dev = (id: string, mount?: Mount): Markup => ({
    id, document_id: 'd', page: 1, type: 'device', text: '', layer_id: null, style: DEFAULT_STYLE,
    geometry: { x: 1, y: 2, width: 24, height: 24, rotation: 0, ...(mount ? { mount } : {}) },
  })
  it('sets and clears the override on every selected device, leaving the rest of the geometry alone', () => {
    const sel = [dev('a'), dev('b', 'square')]
    const set = sel.map(m => withMount(m, 'wall'))
    expect(set.map(m => (m.geometry as BoxGeometry).mount)).toEqual(['wall', 'wall'])
    expect(set[0].geometry).toMatchObject({ x: 1, y: 2, width: 24, height: 24, rotation: 0 })
    const cleared = set.map(m => withMount(m, ''))
    expect(cleared.map(m => 'mount' in m.geometry)).toEqual([false, false])
    expect(withMount(dev('c', 'wall'), null).geometry).toEqual(dev('c').geometry)
    expect(withMount(dev('c'), 'floor').geometry).toEqual(dev('c').geometry)
    expect(sel[1].geometry).toMatchObject({ mount: 'square' }) // input untouched
  })
  it('leaves path markups alone', () => {
    const line: Markup = { ...dev('l'), type: 'line', geometry: { x: 0, y: 0, rotation: 0, points: [0, 0, 5, 5] } }
    expect(withMount(line, 'wall')).toBe(line)
  })
})

describe('wall facing', () => {
  it('puts the flat side down (round side up) when there is no coverage, in the rotated frame', () => {
    expect(wallFacing({ rotation: 0 })).toBe(-90)
    expect(wallFacing({ rotation: 90 })).toBe(-90) // the group rotation turns it on the page
  })
  it('puts the flat side opposite the coverage direction', () => {
    expect(wallFacing({ rotation: 0, fov: { direction: 0, angle: 90, range: 10 } })).toBe(0)
    expect(wallFacing({ rotation: 0, fov: { direction: 90, angle: 90, range: 10 } })).toBe(90)
    // coverage direction is absolute, the shape is drawn in the rotated frame
    expect(wallFacing({ rotation: 90, fov: { direction: 90, angle: 90, range: 10 } })).toBe(0)
    expect(wallFacing({ rotation: 350, fov: { direction: 10, angle: 90, range: 10 } })).toBe(20)
  })
  it('still follows hidden coverage so toggling the cone does not flip the shape', () => {
    expect(wallFacing({ rotation: 0, fov: { direction: 180, angle: 90, range: 10, hidden: true } })).toBe(180)
  })
})

describe('mount shapes', () => {
  const r = 10
  it('circle: the disc itself, icon centred at 1.24 r', () => {
    const s = mountShape('ceiling', r)
    expect(area(s.outline) / (Math.PI * r * r)).toBeGreaterThan(0.99)
    expect(s.icon).toEqual({ cx: 0, cy: 0, size: 12.4 })
  })
  it('square: rounded, about the same area as the circle, inside the disc box', () => {
    const s = mountShape('square', r)
    const ratio = area(s.outline) / (Math.PI * r * r)
    expect(ratio).toBeGreaterThan(0.97)
    expect(ratio).toBeLessThan(1.03)
    for (const v of s.outline) expect(Math.abs(v)).toBeLessThanOrEqual(r)
    // corners are rounded: the exact corner is not part of the outline
    expect(inside(s.outline, 8.8, 8.8)).toBe(false)
    expect(inside(s.outline, 8.5, 0)).toBe(true)
  })
  it('wall: a D whose flat side is behind the centre, within the disc box', () => {
    const s = mountShape('wall', r, 0) // round side to the right
    const xs = s.outline.filter((_, i) => i % 2 === 0), ys = s.outline.filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(-WALL_FLAT * r, 6)
    expect(Math.max(...xs)).toBeCloseTo(r, 6)
    expect(Math.max(...ys)).toBeLessThanOrEqual(r)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-r)
    const ratio = area(s.outline) / (Math.PI * r * r)
    expect(ratio).toBeGreaterThan(0.7)
    expect(ratio).toBeLessThan(0.85)
    // the flat side is straight: exactly the two chord ends sit at the minimum x
    expect(xs.filter(x => Math.abs(x + WALL_FLAT * r) < 1e-6)).toHaveLength(2)
    expect(inside(s.outline, 5, 0)).toBe(true)
    expect(inside(s.outline, -6, 0)).toBe(false)
  })
  it('wall: the flat side follows the facing', () => {
    const d = WALL_FLAT * r
    for (const [facing, fx, fy] of [[0, -1, 0], [90, 0, -1], [180, 1, 0], [-90, 0, 1]] as const) {
      const s = mountShape('wall', r, facing)
      // just inside the flat side is inside the D, just beyond it is not
      expect(inside(s.outline, fx * (d - 0.3), fy * (d - 0.3)), `${facing} in`).toBe(true)
      expect(inside(s.outline, fx * (d + 0.3), fy * (d + 0.3)), `${facing} out`).toBe(false)
    }
  })
  it('wall: default (no coverage) puts the flat side at the bottom', () => {
    const s = mountShape('wall', r, wallFacing({ rotation: 0 }))
    const ys = s.outline.filter((_, i) => i % 2 === 1)
    expect(Math.max(...ys)).toBeCloseTo(WALL_FLAT * r, 6)
    expect(Math.min(...ys)).toBeCloseTo(-r, 6)
  })
  it('an unknown mount draws as the circle', () => {
    expect(mountShape('nope' as Mount, r).mount).toBe('ceiling')
  })
  it('outlineAt shifts to a centre; iconRect is the icon box relative to it', () => {
    const s = mountShape('square', 2)
    const o = outlineAt(s, 100, 50)
    expect(o).toHaveLength(s.outline.length)
    expect(o[0]).toBeCloseTo(s.outline[0] + 100)
    expect(o[1]).toBeCloseTo(s.outline[1] + 50)
    expect(iconRect(s).size).toBeCloseTo(2.48)
    expect(iconRect(s).x).toBeCloseTo(-1.24)
  })
})

describe('safe area', () => {
  it('is an 18x18 square inside the 24x24 icon box', () => {
    expect(SAFE_AREA).toEqual({ min: 3, max: 21 })
    expect(SAFE_AREA.max).toBeLessThanOrEqual(ICON_BOX)
  })
  it('fits inside every shape at every wall facing, clear of the white outline', () => {
    const r = 10, ring = 0.06 * r // half of the 0.12 r outline stroke
    for (const mount of ['ceiling', 'wall', 'square'] as const) {
      for (let facing = -180; facing < 180; facing += 5) {
        const s = mountShape(mount, r, facing)
        for (const [x, y] of safeCorners(s)) {
          expect(inside(s.outline, x, y), `${mount} ${facing} inside`).toBe(true)
          expect(edgeDist(s.outline, x, y), `${mount} ${facing} margin`).toBeGreaterThan(ring + 0.1 * r)
        }
      }
    }
  })
  it('even the whole 24x24 box fits the circle and the square', () => {
    for (const mount of ['ceiling', 'square'] as const) {
      const s = mountShape(mount, 10)
      const half = s.icon.size / 2
      for (const [x, y] of [[-half, -half], [half, -half], [half, half], [-half, half]]) expect(inside(s.outline, x, y), mount).toBe(true)
    }
  })
})
