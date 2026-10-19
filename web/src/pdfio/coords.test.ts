import { describe, expect, it } from 'vitest'
import { applyMatrix, fromPdf, localMatrix, normRotation, toPdf } from './coords'
import type { PageBox } from './coords'

const boxes: PageBox[] = [0, 90, 180, 270].map(rotation => ({ llx: 10, lly: 20, width: 600, height: 400, rotation }))

describe('page coordinate conversion', () => {
  it('flips y for an unrotated page', () => {
    expect(toPdf(boxes[0], 0, 0)).toEqual([10, 420]) // top-left = (llx, lly + height)
    expect(toPdf(boxes[0], 600, 400)).toEqual([610, 20])
  })

  it('maps display corners for each page rotation', () => {
    // pdf.js: rotating 90 puts the unrotated top-left at the display top-right
    expect(fromPdf(boxes[1], 10, 420)).toEqual({ x: 400, y: 0 })
    expect(fromPdf(boxes[2], 10, 420)).toEqual({ x: 600, y: 400 })
    expect(fromPdf(boxes[3], 10, 420)).toEqual({ x: 0, y: 600 })
  })

  it('round trips every rotation', () => {
    for (const b of boxes) {
      for (const [x, y] of [[0, 0], [12.5, 99], [250, 30], [399, 111]]) {
        const [px, py] = toPdf(b, x, y)
        const back = fromPdf(b, px, py)
        expect(back.x).toBeCloseTo(x, 9)
        expect(back.y).toBeCloseTo(y, 9)
      }
    }
  })

  it('local matrix agrees with point conversion, including markup rotation', () => {
    for (const b of boxes) {
      const m = localMatrix(b, 100, 50, 30)
      const a = (30 * Math.PI) / 180
      const lx = 20, ly = 10
      const dx = 100 + lx * Math.cos(a) - ly * Math.sin(a), dy = 50 + lx * Math.sin(a) + ly * Math.cos(a)
      const [ex, ey] = toPdf(b, dx, dy)
      const [gx, gy] = applyMatrix(m, lx, ly)
      expect(gx).toBeCloseTo(ex, 9)
      expect(gy).toBeCloseTo(ey, 9)
    }
  })

  it('normalizes rotation values', () => {
    expect([normRotation(-90), normRotation(450), normRotation(0), normRotation(180)]).toEqual([270, 90, 0, 180])
  })
})
