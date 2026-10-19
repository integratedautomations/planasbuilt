import { describe, expect, it } from 'vitest'
import { absolutePoints, areaPath, buildAreaIndex, deviceCounts, pointInPolygon } from './areas'
import type { Markup } from './types'
import { pathFromPoints } from './geometry'

const rect = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
const style = { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 1 }
function area(id: string, name: string, pts: { x: number; y: number }[], fields: Markup['fields'] = {}, page = 1): Markup {
  return { id, document_id: 'd', page, type: 'area', geometry: pathFromPoints(pts), style, text: name, layer_id: null, fields }
}
const device = (id: string, x: number, y: number, page = 1): Markup => ({
  id, document_id: 'd', page, type: 'device', geometry: { x: x - 12, y: y - 12, width: 24, height: 24, rotation: 0 },
  style, text: '', layer_id: null,
})

describe('pointInPolygon', () => {
  it('handles convex and concave shapes', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, rect(0, 0, 10, 10))).toBe(true)
    expect(pointInPolygon({ x: 15, y: 5 }, rect(0, 0, 10, 10))).toBe(false)
    const L = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }]
    expect(pointInPolygon({ x: 2, y: 8 }, L)).toBe(true)
    expect(pointInPolygon({ x: 8, y: 8 }, L)).toBe(false)
  })
})

describe('absolutePoints', () => {
  it('applies group rotation', () => {
    const m = area('a', 'A', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    m.geometry = { ...m.geometry, rotation: 90 }
    const [p0, p1] = absolutePoints(m)
    expect(p0).toEqual({ x: 0, y: 0 })
    expect(p1.x).toBeCloseTo(0); expect(p1.y).toBeCloseTo(10)
  })
})

describe('hierarchy', () => {
  const floor = area('f', 'First Floor', rect(0, 0, 500, 400))
  const living = area('l', 'Living Room', rect(50, 50, 200, 150))
  const nook = area('n', 'Nook', rect(60, 60, 40, 40))
  const kitchen = area('k', 'Kitchen', rect(300, 50, 150, 150))
  const all = [kitchen, nook, living, floor]

  it('parent is the smallest containing area', () => {
    const idx = buildAreaIndex(all)
    expect(idx.parents.get('n')).toBe('l')
    expect(idx.parents.get('l')).toBe('f')
    expect(idx.parents.get('f')).toBeNull()
  })
  it('builds paths for areas and devices', () => {
    expect(areaPath(nook, all)).toEqual(['First Floor', 'Living Room', 'Nook'])
    expect(areaPath(device('d1', 150, 150), all)).toEqual(['First Floor', 'Living Room'])
    expect(areaPath(device('d2', 80, 80), all)).toEqual(['First Floor', 'Living Room', 'Nook'])
    expect(areaPath(device('d3', 20, 300), all)).toEqual(['First Floor'])
    expect(areaPath(device('d4', 900, 900), all)).toEqual([])
  })
  it('uses the first point of a path markup', () => {
    const line: Markup = { ...device('p', 0, 0), type: 'polyline', geometry: pathFromPoints([{ x: 350, y: 100 }, { x: 10, y: 10 }]) }
    expect(areaPath(line, all)).toEqual(['First Floor', 'Kitchen'])
  })
  it('honors parent_id override and ignores cycles', () => {
    const o = area('k', 'Kitchen', rect(300, 50, 150, 150), { parent_id: 'l' })
    expect(buildAreaIndex([o, living, floor]).parents.get('k')).toBe('l')
    const a = area('l', 'Living Room', rect(50, 50, 200, 150), { parent_id: 'n' })
    const b = area('n', 'Nook', rect(60, 60, 40, 40), { parent_id: 'l' })
    const idx = buildAreaIndex([a, b, floor])
    expect(idx.parents.get('l') === 'n' && idx.parents.get('n') === 'l').toBe(false)
    expect(areaPath(a, [a, b, floor]).length).toBeLessThanOrEqual(3)
  })
  it('ignores identical polygons without looping', () => {
    const x = area('x', 'X', rect(0, 0, 10, 10)), y = area('y', 'Y', rect(0, 0, 10, 10))
    const idx = buildAreaIndex([x, y])
    expect(idx.parents.get('x') === 'y' && idx.parents.get('y') === 'x').toBe(false)
  })
  it('keeps pages separate and uses the sheet area as root', () => {
    const sheet = area('s', 'Second Floor', rect(0, 0, 800, 600), { sheet: true }, 2)
    const room = area('r', 'Office', rect(10, 10, 100, 100), {}, 2)
    const set = [...all, sheet, room]
    expect(areaPath(room, set)).toEqual(['Second Floor', 'Office'])
    expect(areaPath(device('d5', 50, 50, 2), set)).toEqual(['Second Floor', 'Office'])
    expect(areaPath(device('d6', 500, 500, 2), set)).toEqual(['Second Floor'])
    expect(areaPath(device('d7', 150, 150, 1), set)).toEqual(['First Floor', 'Living Room'])
  })
  it('counts devices including nested areas', () => {
    const idx = buildAreaIndex(all)
    const c = deviceCounts(idx, [device('a', 80, 80), device('b', 150, 150), device('c', 350, 100)])
    expect(c.get('n')).toBe(1); expect(c.get('l')).toBe(2); expect(c.get('f')).toBe(3); expect(c.get('k')).toBe(1)
  })
})
