import { describe, expect, it } from 'vitest'
import { markupBounds, markupsInBox } from './selection'
import type { Markup } from './types'

const base = { document_id: 'd', page: 1, style: { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }, text: '', layer_id: null }
const box = (id: string, x: number, y: number, w: number, h: number, rotation = 0): Markup =>
  ({ ...base, id, type: 'rect', geometry: { x, y, width: w, height: h, rotation } })
const area = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Markup> = {}): Markup =>
  ({ ...base, id, type: 'area', geometry: { x, y, rotation: 0, points: [0, 0, w, 0, w, h, 0, h] }, ...extra })

describe('selection box', () => {
  it('intersects partially overlapping markups', () => {
    const ids = markupsInBox([box('a', 0, 0, 10, 10), box('b', 100, 100, 10, 10)], { x: 5, y: 5, width: 20, height: 20 }, new Set())
    expect(ids).toEqual(['a'])
  })
  it('skips locked markups and the sheet area', () => {
    const sheet = area('s', 0, 0, 500, 500, { fields: { sheet: true } })
    expect(markupsInBox([box('a', 0, 0, 10, 10), sheet], { x: 0, y: 0, width: 600, height: 600 }, new Set(['a']))).toEqual([])
  })
  it('selects areas only when fully contained', () => {
    const a = area('r', 10, 10, 100, 100)
    expect(markupsInBox([a], { x: 0, y: 0, width: 50, height: 50 }, new Set())).toEqual([])
    expect(markupsInBox([a], { x: 0, y: 0, width: 200, height: 200 }, new Set())).toEqual(['r'])
  })
  it('accounts for rotation', () => {
    const b = markupBounds(box('a', 0, 0, 10, 10, 90))
    expect(b.x).toBeCloseTo(-10)
    expect(b.width).toBeCloseTo(10)
  })
})
