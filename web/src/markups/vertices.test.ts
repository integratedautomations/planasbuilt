import { describe, expect, it } from 'vitest'
import { canDeleteVertex, insertVertex, nearestSegment, removeVertex } from './vertices'
import { finalizeClickPoints, pathFromPoints } from './geometry'
import { continueSeed, extendCable, pickContinueEnd, reverseCable, trimCableEnds } from './cables'
import { pathPoints } from './snap'
import type { Markup, MarkupType, PathGeometry } from './types'

const style = { stroke: '#e03131', fill: '', strokeWidth: 2, opacity: 1, fontSize: 12 }
const mk = (type: MarkupType, pts: { x: number; y: number }[], extra: object = {}): Markup =>
  ({ id: 'm', document_id: 'd', page: 1, type, geometry: { ...pathFromPoints(pts), ...extra }, style, text: '', layer_id: null }) as Markup

describe('insertVertex', () => {
  const line = mk('polyline', [{ x: 10, y: 10 }, { x: 110, y: 10 }])
  it('adds a point on the segment under the click', () => {
    const r = insertVertex(line, { x: 60, y: 13 }, 8)!
    expect(r.index).toBe(1)
    expect(r.geometry.points).toEqual([0, 0, 50, 0, 100, 0])
  })
  it('ignores clicks away from every segment', () => {
    expect(insertVertex(line, { x: 60, y: 40 }, 8)).toBeNull()
  })
  it('splits the closing edge of a polygon', () => {
    const poly = mk('polygon', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])
    const r = insertVertex(poly, { x: 50, y: 50 }, 4)!
    expect(r.index).toBe(3)
    expect(r.geometry.points.length).toBe(8)
  })
  it('works through rotation and refuses two-point lines', () => {
    const rot = { ...line, geometry: { ...line.geometry, rotation: 90 } } as Markup
    // rotated 90 degrees about (10,10): the segment now runs down from (10,10) to (10,110)
    expect(insertVertex(rot, { x: 10, y: 60 }, 3)?.geometry.points[2]).toBeCloseTo(50)
    expect(insertVertex(mk('line', [{ x: 0, y: 0 }, { x: 100, y: 0 }]), { x: 50, y: 0 }, 4)).toBeNull()
  })
  it('finds the nearest of several segments', () => {
    const h = nearestSegment([0, 0, 100, 0, 100, 100], false, { x: 98, y: 70 })!
    expect(h.index).toBe(1)
  })
})

describe('removeVertex', () => {
  it('removes one vertex and keeps the others', () => {
    const pl = mk('polyline', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }])
    expect(removeVertex(pl, 1)!.points).toEqual([0, 0, 20, 5])
  })
  it('keeps 2 points for open lines and 3 for closed shapes', () => {
    expect(canDeleteVertex(mk('cable', [{ x: 0, y: 0 }, { x: 5, y: 5 }]), 0)).toBe(false)
    expect(canDeleteVertex(mk('polygon', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 9 }]), 1)).toBe(false)
    expect(removeVertex(mk('area', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 9 }, { x: 3, y: 3 }]), 3)!.points.length).toBe(6)
  })
})

describe('finalizeClickPoints', () => {
  const P = (x: number, y: number) => ({ x, y })
  it('drops the point that follows the mouse', () => {
    expect(finalizeClickPoints([P(0, 0), P(10, 0), P(50, 40)])).toEqual([P(0, 0), P(10, 0)])
  })
  it('removes a double-click duplicate', () => {
    expect(finalizeClickPoints([P(0, 0), P(10, 0), P(10, 0), P(10, 0)])).toEqual([P(0, 0), P(10, 0)])
  })
  it('keeps everything when the rubber-band point is already gone', () => {
    expect(finalizeClickPoints([P(0, 0), P(10, 0), P(20, 0)], false).length).toBe(3)
  })
})

describe('continue run', () => {
  const dev = (id: string, cx: number, cy: number): Markup => ({ id, document_id: 'd', page: 1, type: 'device', geometry: { x: cx - 12, y: cy - 12, width: 24, height: 24, rotation: 0 }, style, text: '', layer_id: null })
  const A = dev('A', 0, 0)
  const cable = mk('cable', [{ x: 0, y: 0 }, { x: 100, y: 0 }], { from: 'A' })
  const byId = new Map([[A.id, A], [cable.id, cable]])
  it('prefers the end that is not linked to a device', () => {
    expect(pickContinueEnd(cable, byId, { x: 1, y: 0 })).toBe('to')
  })
  it('uses the nearest end when both are free', () => {
    const free = mk('cable', [{ x: 0, y: 0 }, { x: 100, y: 0 }])
    expect(pickContinueEnd(free, new Map(), { x: 5, y: 0 })).toBe('from')
  })
  it('extends from the tail, and from the head by reversing', () => {
    const g = cable.geometry as PathGeometry
    const to = extendCable(g, 'to', [{ x: 100, y: 50 }])
    expect(pathPoints(to).map(p => [p.x, p.y])).toEqual([[0, 0], [100, 0], [100, 50]])
    expect(to.from).toBe('A')
    const { from: _from, ...bare } = g
    void _from
    const free = extendCable(bare as PathGeometry, 'from', [{ x: -50, y: 0 }])
    expect(pathPoints(free)[0]).toEqual({ x: -50, y: 0 })
    expect(continueSeed(g, 'from')[0]).toEqual({ x: 100, y: 0 })
    expect(reverseCable(g).to).toBe('A')
  })
})

describe('trimCableEnds', () => {
  it('stops a linked end at the symbol edge', () => {
    const out = trimCableEnds([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ end: 'from', c: { x: 0, y: 0 }, r: 12 }])
    expect(out[0].x).toBeCloseTo(12)
    expect(out[1]).toEqual({ x: 100, y: 0 })
  })
  it('leaves a segment shorter than the radius alone', () => {
    expect(trimCableEnds([{ x: 0, y: 0 }, { x: 5, y: 0 }], [{ end: 'to', c: { x: 5, y: 0 }, r: 12 }])[1]).toEqual({ x: 5, y: 0 })
  })
})
