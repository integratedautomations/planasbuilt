import { describe, expect, it } from 'vitest'
import { clampAngle, initialCoverage, normDeg, parseRange, rangeFeet, rangePx, sectorArea, sectorPoints, withRangeFeet, withRangePx } from './coverage'
import type { Fov, SymbolSet } from './types'

const fov: Fov = { direction: -90, angle: 90, range: 150 }
const set = (has_fov: boolean): SymbolSet => ({ id: 's', name: 'S', color: '#000', tag_prefix: 'S', icon: '', fields: [], has_fov, sort: 0 })

describe('coverage units', () => {
  it('uses px without a scale, real feet with one', () => {
    expect(rangePx(fov, null)).toBe(150)
    expect(rangeFeet(fov, null)).toBeNull()
    expect(rangeFeet(fov, 7.5)).toBe(20)
    const f = withRangeFeet(fov, 40, 4)
    expect(f.rangeFt).toBe(40)
    expect(rangePx(f, 4)).toBe(160)
    // scale changes: real length stays correct
    expect(rangePx(f, 8)).toBe(320)
    expect(rangeFeet(f, 8)).toBe(40)
  })
  it('records feet when dragging with a scale and drops them without', () => {
    expect(withRangePx(fov, 80, 8).rangeFt).toBe(10)
    expect(withRangePx({ ...fov, rangeFt: 5 }, 80, null).rangeFt).toBeUndefined()
    expect(withRangePx(fov, 2, null).range).toBe(10)
  })
  it('parses typed lengths', () => {
    expect(parseRange("40'")).toBe(40)
    expect(parseRange("12'-6\"")).toBe(12.5)
    expect(parseRange('0')).toBeNull()
    expect(parseRange('abc')).toBeNull()
  })
  it('builds initial coverage from type default or legacy set flag', () => {
    expect(initialCoverage(set(false), null, 4)).toBeUndefined()
    expect(initialCoverage(set(true), null, null)).toEqual({ direction: -90, angle: 90, range: 150 })
    expect(initialCoverage(set(false), { on: true, angle: 360, range_ft: 30 }, 4)).toMatchObject({ angle: 360, rangeFt: 30, range: 120 })
    expect(initialCoverage(set(false), { on: false, angle: 360, range_ft: 30 }, 4)).toBeUndefined()
  })
  it('clamps angles and normalizes rotation', () => {
    expect(clampAngle(0)).toBe(1)
    expect(clampAngle(500)).toBe(360)
    expect(normDeg(270)).toBe(-90)
    expect(normDeg(-181)).toBe(179)
  })
})

describe('sector geometry', () => {
  it('starts at the apex and spans the angle', () => {
    const p = sectorPoints(10, 90, 0, 2)
    expect(p.slice(0, 2)).toEqual([0, 0])
    expect(p).toHaveLength(2 + 3 * 2)
    const [x0, y0] = [p[2], p[3]], [x1, y1] = [p[6], p[7]]
    expect(Math.atan2(y0, x0)).toBeCloseTo(-Math.PI / 4)
    expect(Math.atan2(y1, x1)).toBeCloseTo(Math.PI / 4)
    for (let i = 2; i < p.length; i += 2) expect(Math.hypot(p[i], p[i + 1])).toBeCloseTo(10)
  })
  it('a 360 sector is a full circle with no apex', () => {
    const p = sectorPoints(5, 360, 0, 8)
    expect(p).toHaveLength(2 * 9)
    expect(p[0]).toBeCloseTo(-5)
    expect(p[p.length - 2]).toBeCloseTo(-5)
  })
  it('computes area', () => {
    expect(sectorArea(10, 360)).toBeCloseTo(Math.PI * 100)
    expect(sectorArea(10, 90)).toBeCloseTo(Math.PI * 25)
  })
})
