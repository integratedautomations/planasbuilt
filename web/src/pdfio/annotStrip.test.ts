import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup } from '../markups/types'
import { detectAnnotations, stripImportedAnnotations } from './annotStrip'
import { exportAnnotated } from './build'
import { planImport } from './importPlan'
import { readAnnotations } from './reader'

async function blank() {
  const d = await PDFDocument.create(); d.addPage([612, 792]); return d.save()
}
const rect: Markup = {
  id: 'r1', document_id: 'doc-1', page: 1, type: 'rect', geometry: { x: 50, y: 50, width: 100, height: 60, rotation: 0 }, text: '', layer_id: null,
  style: { ...DEFAULT_STYLE, stroke: '#1971c2', strokeWidth: 3 },
}

describe('annotation detect / strip', () => {
  it('finds nothing in a plain PDF', async () => {
    expect(await detectAnnotations(await blank())).toBeNull()
  })
  it('detects exported markups and strips them without losing the page', async () => {
    const out = await exportAnnotated({ pdfBytes: await blank(), markups: [rect, { ...rect, id: 'm2', type: 'measure-length', geometry: { x: 100, y: 600, rotation: 0, points: [0, 0, 144, 0] } as Markup['geometry'] }], symbolSets: new Map(), scales: new Map([[1, 8]]), icons: new Map() })
    const found = await detectAnnotations(out)
    expect(found?.restored).toBe(2)
    expect(found?.plan.scales.get(1)).toBeCloseTo(8)
    const stripped = await stripImportedAnnotations(out)
    const doc = await PDFDocument.load(stripped)
    expect(doc.getPageCount()).toBe(1)
    expect(readAnnotations(doc)[0].annots).toHaveLength(0)
    expect(await detectAnnotations(stripped)).toBeNull()
    const again = await planImport(out, { documentId: 'new', existing: new Map(), keepTags: true })
    expect(again.changes).toHaveLength(2)
  })
})
