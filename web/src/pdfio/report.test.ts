import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup, SymbolSet } from '../markups/types'
import { buildReport, deviceRows } from './report'
import { readAnnotations } from './reader'
import { buildRows } from '../schedule/rows'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
const set: SymbolSet = { id: 's1', name: 'Cameras', color: '#1971c2', tag_prefix: 'CAM', icon: '', has_fov: false, sort: 0,
  fields: [{ key: 'ip', label: 'IP address', type: 'ip' }] }
const dev = (i: number, extra: Partial<Markup> = {}): Markup => ({
  id: `d${i}`, document_id: 'doc1', page: 1, type: 'device', text: '', layer_id: null, symbol_set_id: 's1', tag: `CAM-0${i}`,
  status: 'installed', fields: { ip: `10.0.0.${i}`, model: 'X-100' }, created_by_name: 'Ann', created_at: '2026-01-02T00:00:00Z',
  style: DEFAULT_STYLE, geometry: { x: 50 * i, y: 50, width: 28, height: 28, rotation: 0 }, ...extra,
})
const area: Markup = { id: 'a1', document_id: 'doc1', page: 1, type: 'area', text: 'Lobby', layer_id: null, style: DEFAULT_STYLE,
  geometry: { x: 0, y: 0, rotation: 0, points: [0, 0, 400, 0, 400, 400, 0, 400] } }

async function sheet(pages: number) {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([612, 792])
  return d.save()
}

describe('as-built report', () => {
  it('lists every field of a device with area path and people', () => {
    const [row] = buildRows([area, dev(1)], { symbolSets: new Map([[set.id, set]]), docNames: new Map([['doc1', 'E-101']]) })
    const labels = Object.fromEntries(deviceRows(row, set))
    expect(labels).toMatchObject({ Tag: 'CAM-01', Status: 'Installed', Area: 'Lobby', 'IP address': '10.0.0.1', 'Model #': 'X-100', 'Serial #': '-' })
    expect(labels['Placed by']).toContain('Ann')
  })

  it('creates title page + flattened sheets + one page per device, with photos', async () => {
    const markups = [area, dev(1), dev(2), dev(3)]
    const seen: string[] = []
    const bytes = await buildReport({
      projectName: 'School', date: new Date('2026-03-01T12:00:00Z'),
      sheets: [{ documentId: 'doc1', name: 'E-101', pdfBytes: await sheet(2), scales: new Map() }],
      markups, symbolSets: new Map([[set.id, set]]),
      photosFor: async id => { seen.push(id); return id === 'd1' ? [1, 2, 3, 4, 5].map(n => ({ bytes: PNG, caption: `Photo ${n}` })) : [] },
    })
    const doc = await PDFDocument.load(bytes)
    // title + 2 sheet pages + 3 device pages + 1 continuation page for the 5th photo
    expect(doc.getPageCount()).toBe(1 + 2 + 3 + 1)
    expect(seen).toEqual(['d1', 'd2', 'd3'])
    // sheets are flattened: no annotations anywhere
    expect(readAnnotations(doc).every(p => p.annots.length === 0)).toBe(true)
  })

  it('handles a project with no devices', async () => {
    const bytes = await buildReport({
      projectName: 'Empty', date: new Date(), sheets: [{ documentId: 'doc1', name: 'A', pdfBytes: await sheet(1), scales: new Map() }],
      markups: [], symbolSets: new Map(), photosFor: async () => [],
    })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2)
  })
})
