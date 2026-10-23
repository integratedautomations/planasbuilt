import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { editPdf, parsePageList, PageOpError, remapPages, rotateGeometry } from './pages.js'

async function makePdf(sizes: [number, number][]) {
  const doc = await PDFDocument.create()
  for (const [w, h] of sizes) doc.addPage([w, h])
  return doc.save()
}

describe('remapPages', () => {
  it('shifts pages after an insert', () => {
    expect(remapPages({ type: 'insert', at: 2, count: 2 }, 3)).toEqual({ map: [1, 4, 5], newCount: 5 })
    expect(remapPages({ type: 'insert', at: 4, count: 1 }, 3)).toEqual({ map: [1, 2, 3], newCount: 4 })
    expect(remapPages({ type: 'insert', at: 1, count: 1 }, 2).map).toEqual([2, 3])
  })
  it('closes the gap after a delete and marks deleted pages null', () => {
    expect(remapPages({ type: 'delete', pages: [2, 4] }, 5)).toEqual({ map: [1, null, 2, null, 3], newCount: 3 })
  })
  it('maps each old page to its new position on reorder', () => {
    expect(remapPages({ type: 'reorder', order: [3, 1, 2] }, 3)).toEqual({ map: [2, 3, 1], newCount: 3 })
  })
  it('keeps numbers for rotate and replace', () => {
    expect(remapPages({ type: 'rotate', pages: [2], degrees: 90 }, 3).map).toEqual([1, 2, 3])
    expect(remapPages({ type: 'replace', pages: [1, 3] }, 3).map).toEqual([1, 2, 3])
  })
  it('rejects invalid operations', () => {
    expect(() => remapPages({ type: 'delete', pages: [1, 2] }, 2)).toThrow(PageOpError)
    expect(() => remapPages({ type: 'delete', pages: [9] }, 2)).toThrow(PageOpError)
    expect(() => remapPages({ type: 'delete', pages: [] }, 2)).toThrow(PageOpError)
    expect(() => remapPages({ type: 'insert', at: 5, count: 1 }, 2)).toThrow(PageOpError)
    expect(() => remapPages({ type: 'reorder', order: [1, 1, 2] }, 3)).toThrow(PageOpError)
    expect(() => remapPages({ type: 'rotate', pages: [1], degrees: 45 }, 3)).toThrow(PageOpError)
  })
})

describe('rotateGeometry', () => {
  it('turns a page clockwise: the top-left of a 200x100 page goes to the top-right of the 100x200 result', () => {
    const g = rotateGeometry({ x: 0, y: 0, width: 10, height: 10, rotation: 0 }, 90, 200, 100)
    expect(g).toMatchObject({ x: 100, y: 0, rotation: 90, width: 10, height: 10 })
  })
  it('four quarter turns return to the start', () => {
    let g: any = { x: 30, y: 10, points: [0, 0, 5, 5], rotation: 0 }
    let w = 200, h = 100
    for (let i = 0; i < 4; i++) { g = rotateGeometry(g, 90, w, h); [w, h] = [h, w] }
    expect(g).toEqual({ x: 30, y: 10, points: [0, 0, 5, 5], rotation: 0 })
  })
  it('180 turns the cone direction too', () => {
    const a = rotateGeometry({ x: 20, y: 10, width: 4, height: 4, rotation: 0, fov: { direction: 10, angle: 90, range: 5 } }, 180, 200, 100)
    expect(a).toMatchObject({ x: 180, y: 90, rotation: 180, fov: { direction: 190 } })
  })
})

describe('editPdf', () => {
  it('inserts, deletes, reorders, rotates and replaces pages', async () => {
    const src = await makePdf([[100, 100], [200, 200], [300, 300]])
    const extra = await makePdf([[50, 60]])
    const widths = async (b: Uint8Array) => (await PDFDocument.load(b)).getPages().map(p => p.getWidth())

    expect(await widths((await editPdf(src, { type: 'insert', at: 2, count: 1 }, extra)).bytes)).toEqual([100, 50, 200, 300])
    expect(await widths((await editPdf(src, { type: 'delete', pages: [2] })).bytes)).toEqual([100, 300])
    expect(await widths((await editPdf(src, { type: 'reorder', order: [3, 1, 2] })).bytes)).toEqual([300, 100, 200])
    expect(await widths((await editPdf(src, { type: 'replace', pages: [2] }, extra)).bytes)).toEqual([100, 50, 300])
    const rot = await PDFDocument.load((await editPdf(src, { type: 'rotate', pages: [3], degrees: 90 })).bytes)
    expect(rot.getPage(2).getRotation().angle).toBe(90)
    expect(rot.getPage(0).getRotation().angle).toBe(0)
  })
  it('refuses to replace more pages than were uploaded', async () => {
    const src = await makePdf([[100, 100], [200, 200]])
    await expect(editPdf(src, { type: 'replace', pages: [1, 2] }, await makePdf([[10, 10]]))).rejects.toThrow(PageOpError)
  })
})

describe('parsePageList', () => {
  it('reads singles and ranges', () => {
    expect(parsePageList('1-3, 5', 9)).toEqual([1, 2, 3, 5])
    expect(parsePageList('4', 9)).toEqual([4])
    expect(parsePageList('0', 9)).toBeNull()
    expect(parsePageList('3-1', 9)).toBeNull()
    expect(parsePageList('10', 9)).toBeNull()
    expect(parsePageList('a', 9)).toBeNull()
  })
})

describe('parsePageList limits', () => {
  it('rejects a range beyond the real page count instead of expanding it', () => {
    const t = Date.now()
    expect(parsePageList('1-999999999', 5)).toBeNull()
    expect(parsePageList('1-5', 5)).toEqual([1, 2, 3, 4, 5])
    expect(parsePageList('1-5', 0)).toBeNull()
    expect(Date.now() - t).toBeLessThan(500)
  })
})

describe('rotateGeometry keeps linked cable ends on their devices', () => {
  const centre = (g: { x: number; y: number; width: number; height: number; rotation: number }) => {
    const a = (g.rotation * Math.PI) / 180
    return { x: g.x + (g.width / 2) * Math.cos(a) - (g.height / 2) * Math.sin(a), y: g.y + (g.width / 2) * Math.sin(a) + (g.height / 2) * Math.cos(a) }
  }
  const end = (g: { x: number; y: number; rotation: number; points: number[] }) => {
    const a = (g.rotation * Math.PI) / 180, px = g.points[g.points.length - 2], py = g.points[g.points.length - 1]
    return { x: g.x + px * Math.cos(a) - py * Math.sin(a), y: g.y + px * Math.sin(a) + py * Math.cos(a) }
  }
  it('moves the cable end and the device centre to the same place for every quarter turn', () => {
    const dev = { x: 80, y: 30, width: 24, height: 24, rotation: 20 }
    const c = centre(dev)
    // a cable from (10, 10) to the device centre, links preserved untouched
    const cable = { x: 10, y: 10, rotation: 0, points: [0, 0, c.x - 10, c.y - 10], from: 'a', to: 'b' }
    for (const deg of [90, 180, 270]) {
      const d = rotateGeometry(dev, deg, 300, 200)
      const k = rotateGeometry(cable, deg, 300, 200)
      expect(end(k).x).toBeCloseTo(centre(d).x, 6)
      expect(end(k).y).toBeCloseTo(centre(d).y, 6)
      expect(k).toMatchObject({ from: 'a', to: 'b' })
    }
  })
})
