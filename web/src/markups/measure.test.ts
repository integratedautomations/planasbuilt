import { describe, expect, it } from 'vitest'
import { formatArea, formatFeetInches, parseFeetInches, pathMidpoint, polygonArea, polygonPerimeter, polylineLength, SCALE_PRESETS } from './measure'

describe('lengths and areas', () => {
  it('polyline length', () => {
    expect(polylineLength([0, 0, 3, 4, 3, 10])).toBeCloseTo(11)
    expect(polylineLength([0, 0])).toBe(0)
  })
  it('polygon area/perimeter, either winding', () => {
    expect(polygonArea([0, 0, 10, 0, 10, 5, 0, 5])).toBe(50)
    expect(polygonArea([0, 0, 0, 5, 10, 5, 10, 0])).toBe(50)
    expect(polygonPerimeter([0, 0, 10, 0, 10, 5, 0, 5])).toBe(30)
    expect(polygonArea([0, 0, 1, 1])).toBe(0)
  })
  it('midpoint', () => {
    expect(pathMidpoint([0, 0, 10, 0, 10, 10])).toEqual({ x: 10, y: 0 })
  })
})

describe('formatFeetInches', () => {
  it('formats', () => {
    expect(formatFeetInches(0)).toBe(`0'-0"`)
    expect(formatFeetInches(12.5)).toBe(`12'-6"`)
    expect(formatFeetInches(12 + 6.5 / 12)).toBe(`12'-6 1/2"`)
    expect(formatFeetInches(8 / 12)).toBe(`0'-8"`)
    expect(formatFeetInches(0.5 / 12)).toBe(`0'-1/2"`)
  })
  it('rolls inches over into feet', () => {
    expect(formatFeetInches(1 - 0.01 / 12)).toBe(`1'-0"`)
    expect(formatFeetInches(5 + 11.99 / 12)).toBe(`6'-0"`)
  })
  it('formats area', () => {
    expect(formatArea(1234.5)).toBe('1,234.5 SF')
    expect(formatArea(0)).toBe('0.0 SF')
  })
})

describe('parseFeetInches', () => {
  const cases: [string, number][] = [
    [`12'6"`, 12.5], [`12' 6 1/2"`, 12 + 6.5 / 12], [`12'-6"`, 12.5], ['12.5', 12.5], [`12'`, 12],
    [`150"`, 12.5], [`6 1/2"`, 6.5 / 12], [`1/2"`, 0.5 / 12], [`12'6`, 12.5],
  ]
  for (const [s, v] of cases) it(s, () => expect(parseFeetInches(s)).toBeCloseTo(v))
  it('rejects junk', () => {
    for (const s of ['', 'abc', "12'x", '1/0"', '--', '6 1/2']) expect(parseFeetInches(s)).toBeNull()
  })
})

describe('presets', () => {
  it('has expected values', () => {
    expect(SCALE_PRESETS.find(p => p.label.startsWith('1/8"'))!.pointsPerFoot).toBe(9)
    expect(SCALE_PRESETS.find(p => p.label === `1" = 20'`)!.pointsPerFoot).toBeCloseTo(3.6)
    expect(SCALE_PRESETS.find(p => p.label.startsWith('3"'))!.pointsPerFoot).toBe(216)
  })
})
