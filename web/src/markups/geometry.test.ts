import { describe, expect, it } from 'vitest'
import { bakeBox, bakePath, boxFromDrag, deviceCenter, pathFromPoints, simplify, snap45 } from './geometry'

describe('geometry', () => {
  it('snaps to 45° keeping length', () => {
    const p = snap45({ x: 0, y: 0 }, { x: 10, y: 1 })
    expect(p.x).toBeCloseTo(Math.hypot(10, 1))
    expect(p.y).toBeCloseTo(0)
    const d = snap45({ x: 0, y: 0 }, { x: 10, y: 9 })
    expect(d.x).toBeCloseTo(d.y)
  })

  it('normalizes drag boxes in any direction and squares them', () => {
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 0, y: 4 })).toEqual({ x: 0, y: 4, width: 10, height: 6, rotation: 0 })
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 0, y: 4 }, true)).toEqual({ x: 0, y: 0, width: 10, height: 10, rotation: 0 })
  })

  it('anchors paths at the first point', () => {
    expect(pathFromPoints([{ x: 5, y: 5 }, { x: 8, y: 9 }])).toEqual({ x: 5, y: 5, rotation: 0, points: [0, 0, 3, 4] })
  })

  it('bakes resize scale into stored geometry', () => {
    expect(bakeBox({ x: 1, y: 2, rotation: 30, width: 10, height: 20 }, 2, 0.5))
      .toEqual({ x: 1, y: 2, rotation: 30, width: 20, height: 10 })
    expect(bakePath({ x: 0, y: 0, rotation: 0, points: [0, 0, 10, 10] }, 3, 2).points).toEqual([0, 0, 30, 20])
  })

  it('finds a rotated device center', () => {
    const c = deviceCenter({ x: 10, y: 10, width: 20, height: 20, rotation: 90 })
    expect(c.x).toBeCloseTo(0)
    expect(c.y).toBeCloseTo(20)
  })

  it('simplifies dense freehand input but keeps endpoints', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.2, y: 0 }))
    const s = simplify(pts)
    expect(s.length).toBeLessThan(10)
    expect(s[0]).toEqual(pts[0])
    expect(s[s.length - 1]).toEqual(pts[49])
  })
})
