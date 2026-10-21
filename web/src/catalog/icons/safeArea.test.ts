import { describe, expect, it } from 'vitest'
import { ICONS } from './library'
import { bodyBounds } from './pabValidate'
import { SAFE_AREA } from '../../markups/mount'

describe('built-in icons', () => {
  it('bodyBounds measures shapes, arcs and curves', () => {
    expect(bodyBounds('<circle cx="12" cy="12" r="5"/>')).toEqual({ x0: 7, y0: 7, x1: 17, y1: 17 })
    expect(bodyBounds('<rect x="4" y="5" width="10" height="6"/>')).toEqual({ x0: 4, y0: 5, x1: 14, y1: 11 })
    const q = bodyBounds('<path d="M4 20Q12 4 20 20"/>') // the curve peaks at y = 12, not at the control point
    expect(q.y0).toBeCloseTo(12, 1)
    const a = bodyBounds('<path d="M4 12A8 8 0 0 1 20 12"/>')
    expect(a.y0).toBeCloseTo(4, 1)
  })
  it('every option (A and B) draws no container and stays inside the safe area', () => {
    const { min, max } = SAFE_AREA
    for (const i of ICONS) {
      const b = bodyBounds(i.body)
      expect(b.x0, `${i.id} left`).toBeGreaterThanOrEqual(min - 0.01)
      expect(b.y0, `${i.id} top`).toBeGreaterThanOrEqual(min - 0.01)
      expect(b.x1, `${i.id} right`).toBeLessThanOrEqual(max + 0.01)
      expect(b.y1, `${i.id} bottom`).toBeLessThanOrEqual(max + 0.01)
    }
  })
})
