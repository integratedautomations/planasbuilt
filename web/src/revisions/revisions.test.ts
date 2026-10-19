import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { BoxGeometry, Markup, PathGeometry } from '../markups/types'
import { cloudChange, mergeBoxes } from './clouds'
import { changeEntries, diffIsEmpty, diffMarkups, groupByPage } from './diff'
import { diffPixels, rectsToPage, tintInk } from './pixelDiff'

let n = 0
const box = (x: number, y: number, width = 20, height = 20, rotation = 0): BoxGeometry => ({ x, y, width, height, rotation })
const mk = (extra: Partial<Markup> = {}): Markup => ({
  id: `m${++n}`, document_id: 'd', page: 1, type: 'device', geometry: box(100, 100), style: { ...DEFAULT_STYLE }, text: '', layer_id: null,
  tag: 'CAM-01', status: 'planned', fields: { ip: '10.0.0.1' }, ...extra,
})

describe('diffMarkups', () => {
  it('finds nothing between identical sets', () => {
    const a = [mk(), mk()]
    expect(diffIsEmpty(diffMarkups(a, structuredClone(a)))).toBe(true)
  })

  it('reports added and removed by id', () => {
    const keep = mk(), gone = mk(), fresh = mk()
    const d = diffMarkups([keep, gone], [keep, fresh])
    expect(d.added.map(m => m.id)).toEqual([fresh.id])
    expect(d.removed.map(m => m.id)).toEqual([gone.id])
  })

  it('treats a center move over 2pt as moved, and smaller as unchanged', () => {
    const a = mk()
    const small = { ...a, geometry: box(101.5, 100) }
    const big = { ...a, geometry: box(105, 100) }
    expect(diffMarkups([a], [small]).moved).toHaveLength(0)
    const d = diffMarkups([a], [big])
    expect(d.moved).toHaveLength(1)
    expect(d.moved[0].distance).toBeCloseTo(5)
    expect(d.resized).toHaveLength(0)
  })

  it('reports a size change as resized', () => {
    const a = mk()
    const d = diffMarkups([a], [{ ...a, geometry: box(100, 100, 40, 20) }])
    expect(d.resized).toHaveLength(1)
  })

  it('reports a reshaped path and a turned shape as resized, a pure path move as moved only', () => {
    const path = (points: number[], x = 10): Markup => mk({ type: 'polyline', geometry: { x, y: 10, rotation: 0, points } as PathGeometry })
    const a = path([0, 0, 50, 0, 50, 50])
    const reshaped = { ...a, geometry: { ...a.geometry, points: [0, 0, 50, 0, 50, 49 + 10] } as PathGeometry }
    expect(diffMarkups([a], [reshaped]).resized).toHaveLength(1)
    const shifted = { ...a, geometry: { ...a.geometry, x: 60 } as PathGeometry }
    const d = diffMarkups([a], [shifted])
    expect(d.moved).toHaveLength(1)
    expect(d.resized).toHaveLength(0)
    const r = mk({ geometry: box(100, 100, 40, 10) })
    expect(diffMarkups([r], [{ ...r, geometry: box(100, 100, 40, 10, 30) }]).resized).toHaveLength(1)
  })

  it('lists changed field keys with old and new values', () => {
    const a = mk()
    const b = { ...a, fields: { ip: '10.0.0.2', mac: 'aa' }, tag: 'CAM-02', product_id: 'p1' }
    const d = diffMarkups([a], [b])
    expect(d.fieldsChanged).toHaveLength(1)
    expect(d.fieldsChanged[0].changes).toEqual(expect.arrayContaining([
      { key: 'tag', old: 'CAM-01', new: 'CAM-02' },
      { key: 'product_id', old: '', new: 'p1' },
      { key: 'fields.ip', old: '10.0.0.1', new: '10.0.0.2' },
      { key: 'fields.mac', old: null, new: 'aa' },
    ]))
  })

  it('reports status and style changes separately', () => {
    const a = mk()
    const b = { ...a, status: 'installed' as const, style: { ...a.style, stroke: '#00f' } }
    const d = diffMarkups([a], [b])
    expect(d.statusChanged).toEqual([expect.objectContaining({ from: 'planned', to: 'installed' })])
    expect(d.restyled).toHaveLength(1)
    expect(d.fieldsChanged).toHaveLength(0)
  })

  it('counts a page change as a move', () => {
    const a = mk()
    expect(diffMarkups([a], [{ ...a, page: 2 }]).moved).toHaveLength(1)
  })
})

describe('change list', () => {
  it('merges kinds per markup and groups by page with counts', () => {
    const a = mk(), b = mk({ page: 2 }), c = mk({ page: 2 })
    const d = diffMarkups([a, b], [{ ...a, geometry: box(150, 100), status: 'tested' }, c])
    const entries = changeEntries(d)
    const forA = entries.find(e => e.id === a.id)!
    expect(forA.kinds).toEqual(['moved', 'status'])
    const pages = groupByPage(entries)
    expect(pages.map(p => p.page)).toEqual([1, 2])
    expect(pages[0].counts).toMatchObject({ moved: 1, status: 1, added: 0 })
    expect(pages[1].counts).toMatchObject({ added: 1, removed: 1 })
  })
})

describe('clouds', () => {
  const r = (x: number, y: number, w = 10, h = 10) => ({ x, y, width: w, height: h })
  it('merges nearby boxes and keeps far ones apart', () => {
    const merged = mergeBoxes([r(0, 0), r(15, 0), r(500, 500)], 24)
    expect(merged).toHaveLength(2)
    expect(merged).toContainEqual({ x: 0, y: 0, width: 25, height: 10 })
  })
  it('chains merges (a-b, b-c makes a-b-c)', () => {
    expect(mergeBoxes([r(0, 0), r(30, 0), r(60, 0)], 24)).toHaveLength(1)
  })
  it('creates one cloud per merged box as a single change, on the given layer', () => {
    let i = 0
    const change = cloudChange([{ page: 1, rect: r(0, 0) }, { page: 1, rect: r(12, 0) }, { page: 3, rect: r(200, 200) }],
      { documentId: 'd', layerId: 'L', newId: () => `c${++i}` })
    expect(change).toHaveLength(2)
    expect(change.every(c => c.before === null && c.after!.type === 'cloud' && c.after!.layer_id === 'L')).toBe(true)
    expect(change.map(c => c.after!.page)).toEqual([1, 3])
    expect(change[0].after!.geometry).toMatchObject({ x: -10, y: -10, width: 42, height: 30 })
  })
})

describe('diffPixels', () => {
  const blank = (w: number, h: number, v = 255) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255 }
    return { width: w, height: h, data }
  }
  const fill = (img: ReturnType<typeof blank>, x0: number, y0: number, w: number, h: number, v: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v }
  }

  it('finds nothing in identical images', () => {
    expect(diffPixels(blank(64, 64), blank(64, 64))).toEqual([])
  })
  it('finds a changed block as one region and ignores tiny differences', () => {
    const a = blank(128, 128), b = blank(128, 128)
    fill(b, 40, 40, 20, 12, 0)
    fill(a, 5, 5, 1, 1, 200) // luminance 55 away: a single pixel is below minPixels per cell
    const regions = diffPixels(a, b)
    expect(regions).toHaveLength(1)
    const [g] = regions
    expect(g.x).toBeLessThanOrEqual(40)
    expect(g.y).toBeLessThanOrEqual(40)
    expect(g.x + g.width).toBeGreaterThanOrEqual(60)
    expect(g.y + g.height).toBeGreaterThanOrEqual(52)
  })
  it('separates distant changes and joins near ones', () => {
    const a = blank(256, 128), b = blank(256, 128)
    fill(b, 10, 10, 8, 8, 0)
    fill(b, 26, 10, 8, 8, 0) // two cells away: joined
    fill(b, 200, 100, 8, 8, 0)
    const regions = diffPixels(a, b, { cell: 8, gap: 2 })
    expect(regions).toHaveLength(2)
    expect(regions[0].width).toBeGreaterThanOrEqual(24)
  })
  it('compares only the shared area and reports page-space rects', () => {
    const a = blank(64, 64), b = blank(32, 32)
    fill(a, 50, 50, 10, 10, 0) // outside b: not compared
    expect(diffPixels(a, b)).toEqual([])
    expect(rectsToPage([{ x: 20, y: 40, width: 10, height: 10 }], 2)).toEqual([{ x: 10, y: 20, width: 5, height: 5 }])
  })
})

describe('tintInk', () => {
  it('keeps white, and turns dark ink pure red or cyan', () => {
    const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])
    const red = new Uint8ClampedArray(px)
    tintInk(red, 'red')
    expect([...red]).toEqual([255, 255, 255, 255, 255, 0, 0, 255])
    const cyan = new Uint8ClampedArray(px)
    tintInk(cyan, 'cyan')
    expect([...cyan]).toEqual([255, 255, 255, 255, 0, 255, 255, 255])
  })
})
