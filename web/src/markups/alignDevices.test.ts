import { describe, expect, it } from 'vitest'
import { ALIGN_SEARCH_POINTS, alignRadius, alignWithNearby } from './alignDevices'
import type { Markup } from './types'

const style = { stroke: '#e03131', fill: '', strokeWidth: 2, opacity: 1, fontSize: 12 }
const dev = (id: string, cx: number, cy: number, o: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd', page: 1, type: 'device', geometry: { x: cx - 12, y: cy - 12, width: 24, height: 24, rotation: 0 }, style, text: '', layer_id: null,
  symbol_set_id: 's1', device_type_id: 't1', ...o,
})
const base = { tol: 5, radius: 300 }

describe('alignWithNearby', () => {
  it('snaps x to a device in the same column and reports the guide', () => {
    const r = alignWithNearby({ x: 103, y: 250 }, [dev('a', 100, 100)], { ...base, typeId: 't1', setId: 's1' })!
    expect(r.point).toEqual({ x: 100, y: 250 })
    expect(r.guides).toEqual([{ from: { x: 100, y: 100 }, to: { x: 100, y: 250 }, axis: 'x' }])
  })
  it('snaps both axes to different devices', () => {
    const r = alignWithNearby({ x: 102, y: 198 }, [dev('a', 100, 50), dev('b', 300, 200)], { ...base, typeId: 't1' })!
    expect(r.point).toEqual({ x: 100, y: 200 })
    expect(r.guides.map(g => g.axis)).toEqual(['x', 'y'])
  })
  it('ignores devices outside the tolerance, radius, other types / pages and the skipped ones', () => {
    const p = { x: 110, y: 400 }
    expect(alignWithNearby(p, [dev('a', 100, 100)], { ...base, typeId: 't1' })).toBeNull() // 10 > tol
    expect(alignWithNearby({ x: 101, y: 900 }, [dev('a', 100, 100)], { ...base, typeId: 't1' })).toBeNull() // beyond radius
    expect(alignWithNearby({ x: 101, y: 200 }, [dev('a', 100, 100, { device_type_id: 't2' })], { ...base, typeId: 't1' })).toBeNull()
    expect(alignWithNearby({ x: 101, y: 200 }, [dev('a', 100, 100, { page: 2 })], { ...base, typeId: 't1', page: 1 })).toBeNull()
    expect(alignWithNearby({ x: 101, y: 200 }, [dev('a', 100, 100)], { ...base, typeId: 't1', skip: new Set(['a']) })).toBeNull()
  })
  it('matches the set when no type is given, and nothing when neither is known', () => {
    expect(alignWithNearby({ x: 101, y: 200 }, [dev('a', 100, 100)], { ...base, setId: 's1' })).not.toBeNull()
    expect(alignWithNearby({ x: 101, y: 200 }, [dev('a', 100, 100, { symbol_set_id: 's2' })], { ...base, setId: 's1' })).toBeNull()
    expect(alignWithNearby({ x: 101, y: 200 }, [dev('a', 100, 100)], base)).toBeNull()
  })
  it('prefers the closest alignment per axis', () => {
    const r = alignWithNearby({ x: 103, y: 500 }, [dev('a', 100, 300), dev('b', 102, 400)], { ...base, typeId: 't1' })!
    expect(r.point.x).toBe(102)
  })
  it('radius follows the page scale', () => {
    expect(alignRadius(null)).toBe(ALIGN_SEARCH_POINTS)
    expect(alignRadius(5)).toBe(200)
  })
})
