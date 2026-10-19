import { describe, expect, it } from 'vitest'
import { bomTable, computeBom } from './bom'
import type { BomDevice } from './bom'
import { buildCatalog } from './catalog'
import { data, sets } from './fixtures'

const cat = buildCatalog(data)
const setMap = new Map(sets.map(s => [s.id, s]))
const dev = (o: Partial<BomDevice>): BomDevice => ({ setId: 'fa', typeId: 'sd', productId: 'pad', documentId: 'd1', areaPath: [], ...o })

describe('computeBom', () => {
  it('counts devices, rolls up and merges accessories, and totals cost and labor', () => {
    const bom = computeBom([dev({}), dev({}), dev({ setId: 'cam', typeId: 'ipc', productId: 'cam1' })], cat, setMap)
    const by = Object.fromEntries(bom.lines.map(l => [l.key, l]))
    expect(by['p:pad']).toMatchObject({ qty: 2, extCost: 120, extLabor: 1, section: 'devices' })
    expect(by['p:cam1']).toMatchObject({ qty: 1, extCost: 500 })
    // base: 1 per smoke x 2 + 2 per camera = 4, merged into one line
    expect(by['p:base']).toMatchObject({ qty: 4, accessoryQty: 4, extCost: 32, extLabor: 1, section: 'accessories' })
    expect(by['c:label|1|0']).toMatchObject({ qty: 4, extCost: 4 })
    expect(bom.totals).toEqual({ qty: 2 + 1 + 4 + 4, cost: 120 + 500 + 32 + 4, labor: 1 + 1.5 + 1 })
  })
  it('lists devices without a product as Unassigned <type>', () => {
    const bom = computeBom([dev({ productId: null }), dev({ productId: null }), dev({ setId: 'cam', typeId: null, productId: null }), dev({ productId: 'missing' })], cat, setMap)
    expect(bom.lines.map(l => [l.name, l.qty, l.section])).toEqual([
      ['Unassigned Cameras', 1, 'unassigned'], ['Unassigned Smoke Detector', 3, 'unassigned']])
    expect(bom.totals.cost).toBe(0)
  })
  it('filters by document and area, and counts inactive products', () => {
    const devices = [dev({ documentId: 'd1', areaPath: ['L1', 'Lobby'] }), dev({ documentId: 'd2', areaPath: ['L2'] }), dev({ productId: 'old', typeId: 'ipc', setId: 'cam', documentId: 'd2' })]
    expect(computeBom(devices, cat, setMap, { documentId: 'd2' }).lines.find(l => l.key === 'p:pad')?.qty).toBe(1)
    expect(computeBom(devices, cat, setMap, { area: 'L1 > Lobby' }).totals.qty).toBe(1 + 1 + 2)
    expect(computeBom(devices, cat, setMap, { area: 'L1' }).totals.qty).toBe(1 + 1 + 2)
    expect(computeBom(devices, cat, setMap, { area: 'Lobby' }).totals.qty).toBe(0)
    expect(computeBom(devices, cat, setMap).lines.find(l => l.key === 'p:old')?.qty).toBe(1)
  })
  it('survives accessory cycles and builds table cells', () => {
    const loop = buildCatalog({ ...data, products: data.products.map(p => (p.id === 'base' ? { ...p, accessories: [{ product_id: 'pad', qty: 1 }] } : p)) })
    expect(() => computeBom([dev({})], loop, setMap)).not.toThrow()
    const t = bomTable(computeBom([dev({})], cat, setMap))
    expect(t.header[0]).toBe('Section')
    expect(t.rows[0].slice(2, 6)).toEqual(['Potter', 'PAD100', 'Photo smoke', 1])
    expect(t.totals[0]).toBe('Total')
  })
})

describe('bom export', () => {
  it('builds an Excel table with a totals row and a PDF', async () => {
    const { bomWorkbookTable, buildBomPdf, bomFileName } = await import('./bomExport')
    const bom = computeBom([dev({}), dev({})], cat, setMap)
    const t = bomWorkbookTable(bom)
    expect(t.name).toBe('BOM')
    expect(t.data.at(-1)![0]).toBe('Total')
    expect(t.data.at(-1)![8]).toBe(bom.totals.cost)
    const bytes = await buildBomPdf(bom, { projectName: 'School', scope: 'Whole project', date: new Date('2026-03-01T12:00:00Z') })
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    expect(bomFileName('A/B', 'pdf', new Date(2026, 2, 1))).toBe('A-B - BOM - 2026-03-01.pdf')
  })
})
