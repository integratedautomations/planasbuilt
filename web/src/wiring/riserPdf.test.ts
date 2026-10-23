import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildCatalog } from '../catalog/catalog'
import { pathFromPoints } from '../markups/geometry'
import type { Markup, SymbolSet } from '../markups/types'
import { buildReport } from '../pdfio/report'
import { DEFAULT_REPORT_OPTIONS } from '../pdfio/reportOptions'
import { buildRiserPdf, riserFileName, riserPages } from './riserPdf'
import type { RiserInput } from './riserPdf'

const style = { stroke: '#e03131', fill: '', strokeWidth: 2, opacity: 1, fontSize: 12 }
const set: SymbolSet = { id: 's', name: 'Network', color: '#7048e8', tag_prefix: 'N', icon: '', fields: [], has_fov: false, sort: 0 }
const catalog = buildCatalog({
  device_types: [
    { id: 'sw', symbol_set_id: 's', name: 'Network Switch', icon: '', tag_prefix: null, fields: [], default_product_id: null, mount: 'square', sort: 1 },
    { id: 'cam', symbol_set_id: 's', name: 'Camera', icon: '', tag_prefix: null, fields: [], default_product_id: null, mount: 'ceiling', sort: 2 },
  ],
  products: [], cable_types: [{ id: 'c6', name: 'Cat6', color: '#1971c2', sort: 1 }],
})
const dev = (id: string, tag: string, type: string, x: number, y: number): Markup => ({
  id, tag, document_id: 'd1', page: 1, type: 'device', device_type_id: type, symbol_set_id: 's',
  geometry: { x: x - 12, y: y - 12, width: 24, height: 24, rotation: 0 }, style, text: '', layer_id: null,
})
const link = (a: Markup, b: Markup): Markup => ({
  id: `k-${b.id}`, document_id: 'd1', page: 1, type: 'cable', style, text: '', layer_id: null, fields: { cable_type: 'c6' },
  geometry: { ...pathFromPoints([{ x: a.geometry.x + 12, y: a.geometry.y + 12 }, { x: b.geometry.x + 12, y: b.geometry.y + 12 }]), from: a.id, to: b.id },
})
const hub = dev('h', 'SW-01', 'sw', 50, 50)
const cams = Array.from({ length: 40 }, (_, i) => dev(`c${i}`, `CAM-${i}`, 'cam', 100 + i, 100))
const markups = [hub, ...cams, ...cams.map(c => link(hub, c)), dev('lonely', 'CAM-X', 'cam', 900, 900)]
const input: RiserInput = {
  projectName: 'School', date: new Date('2026-03-01T12:00:00Z'), markups, symbolSets: new Map([['s', set]]), catalog,
  docNames: new Map([['d1', 'Floor 1']]), scaleFor: () => 10, defaults: { slackPct: 10, dropFt: 2 },
}

describe('riser PDF', () => {
  it('draws every laid-out page at tabloid landscape size', async () => {
    const bytes = await buildRiserPdf(input)
    const doc = await PDFDocument.load(bytes)
    const pages = riserPages(input)
    expect(doc.getPageCount()).toBe(pages.length)
    expect(pages.length).toBeGreaterThan(1) // 40 devices paginate, plus the Not connected page
    for (const p of doc.getPages()) expect(p.getSize()).toEqual({ width: 1224, height: 792 })
  })
  it('names the file after the project and date', () => {
    expect(riserFileName('A/B: School', new Date(2026, 2, 5))).toBe('A-B- School - Wiring riser - 2026-03-05.pdf')
  })
  it('is appended to the as-built report when asked', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([200, 200])
    const sheet = { documentId: 'd1', name: 'Floor 1', pdfBytes: await pdf.save(), scales: new Map([[1, 10]]) }
    const base = { projectName: 'School', date: new Date(), sheets: [sheet], markups, symbolSets: new Map([['s', set]]), catalog, photosFor: async () => [] }
    const off = await PDFDocument.load(await buildReport({ ...base, options: { ...DEFAULT_REPORT_OPTIONS, titlePage: false, includeSheets: false, includeDevices: false, includeWiring: false } }))
    const on = await PDFDocument.load(await buildReport({ ...base, options: { ...DEFAULT_REPORT_OPTIONS, titlePage: false, includeSheets: false, includeDevices: false, includeWiring: true } }))
    expect(on.getPageCount() - off.getPageCount()).toBeGreaterThanOrEqual(1)
    expect(on.getPages().some(p => p.getWidth() === 1224)).toBe(true)
  })
})
