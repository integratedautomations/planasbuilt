import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildCatalog } from '../catalog/catalog'
import { legendFields, DEFAULT_LEGEND } from '../markups/legend'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup, SymbolSet } from '../markups/types'
import { exportAnnotated, exportFlattened } from './build'
import { planImport } from './importPlan'
import { readAnnotations } from './reader'

const set: SymbolSet = { id: 's1', name: 'Fire', color: '#e03131', tag_prefix: 'FA', icon: '', fields: [], has_fov: false, sort: 0 }
const catalog = buildCatalog({
  device_types: [{ id: 't1', symbol_set_id: 's1', name: 'Smoke detector', icon: '', tag_prefix: 'SD', fields: [], default_product_id: null, sort: 0 }],
  products: [],
})
const dev = (id: string, x: number): Markup => ({
  id, document_id: 'doc', page: 1, type: 'device', geometry: { x, y: 100, width: 24, height: 24, rotation: 0 },
  style: DEFAULT_STYLE, text: '', layer_id: null, symbol_set_id: 's1', device_type_id: 't1', tag: `SD-0${id}`,
})
const legend: Markup = {
  id: 'L1', document_id: 'doc', page: 1, type: 'legend', geometry: { x: 300, y: 300, width: 220, height: 100, rotation: 0 },
  style: { ...DEFAULT_STYLE, stroke: '#343a40', fill: '#ffffff', strokeWidth: 1, fontSize: 12 }, text: '', layer_id: null,
  fields: legendFields({ ...DEFAULT_LEGEND, columns: ['icon', 'name', 'code', 'count'], title: 'Devices' }),
}

async function blank() {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  return doc.save()
}

describe('legend export', () => {
  it('exports a legend stamp with a live count and restores it on import', async () => {
    const pdfBytes = await blank()
    const markups = [dev('1', 50), dev('2', 100), dev('3', 150), legend]
    const out = await exportAnnotated({ pdfBytes, markups, symbolSets: new Map([[set.id, set]]), scales: new Map(), catalog })
    const doc = await PDFDocument.load(out)
    const annots = readAnnotations(doc)[0].annots
    const stamp = annots.find(a => a.stampName === 'Legend')!
    expect(stamp.subtype).toBe('Stamp')
    expect(stamp.contents).toContain('Smoke detector: 3')
    const plan = await planImport(out, { documentId: 'doc', existing: new Map(markups.map(m => [m.id, m])), known: { layers: new Set(), symbolSets: new Set(['s1']), deviceTypes: new Set(['t1']), products: new Set() } })
    expect(plan.changes).toHaveLength(0)
    expect(plan.unchanged).toBe(4)
  })

  it('flattens a legend into the page content', async () => {
    const pdfBytes = await blank()
    const out = await exportFlattened({ pdfBytes, markups: [dev('1', 50), legend], symbolSets: new Map([[set.id, set]]), scales: new Map(), catalog })
    const doc = await PDFDocument.load(out)
    expect(readAnnotations(doc)[0].annots).toHaveLength(0)
    expect(out.length).toBeGreaterThan(pdfBytes.length)
  })

  it('exports a sorted, grouped legend with the extra columns', async () => {
    const pdfBytes = await blank()
    const fancy: Markup = { ...legend, fields: legendFields({ ...DEFAULT_LEGEND, columns: ['name', 'manufacturer', 'set', 'count'], sort: 'count-desc', groupBySet: true, showZero: true, aligns: { name: 'center' }, widths: { set: 2 } }) }
    const out = await exportFlattened({ pdfBytes, markups: [dev('1', 50), dev('2', 100), fancy], symbolSets: new Map([[set.id, set]]), scales: new Map(), catalog })
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1)
  })
})
