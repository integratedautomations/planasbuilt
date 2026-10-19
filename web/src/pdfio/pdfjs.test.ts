import { PDFDocument, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup } from '../markups/types'
import { exportAnnotated } from './build'

// pdf.js is what the viewer (and many other tools) use: it must open our output and see every annotation with an appearance.
describe('pdf.js reads exported annotations', () => {
  it('parses annotations and their appearance streams', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const base = await PDFDocument.create()
    base.addPage([612, 792]).setRotation(degrees(90))
    const mk = (id: string, type: Markup['type'], geometry: Markup['geometry'], extra: Partial<Markup> = {}): Markup => ({
      id, document_id: 'd', page: 1, type, geometry, text: '', layer_id: null, style: { ...DEFAULT_STYLE, stroke: '#1971c2' }, ...extra })
    const markups = [
      mk('a', 'rect', { x: 50, y: 60, width: 100, height: 40, rotation: 0 }),
      mk('b', 'cloud', { x: 200, y: 60, width: 100, height: 60, rotation: 0 }),
      mk('c', 'arrow', { x: 50, y: 200, rotation: 0, points: [0, 0, 100, 50] }),
      mk('d', 'text', { x: 50, y: 300, width: 150, height: 50, rotation: 0 }, { text: 'Note \u00b0 here' }),
      mk('e', 'measure-length', { x: 50, y: 400, rotation: 0, points: [0, 0, 144, 0] }),
    ]
    const bytes = await exportAnnotated({ pdfBytes: await base.save(), markups, symbolSets: new Map(), scales: new Map([[1, 9]]) })
    const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 })
    const doc = await task.promise
    const page = await doc.getPage(1)
    const annots = await page.getAnnotations()
    expect(annots.map((a: any) => a.subtype).sort()).toEqual(['FreeText', 'Line', 'Line', 'Polygon', 'Square'])
    expect(annots.every((a: any) => !!a.hasAppearance)).toBe(true)
    const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE })
    expect(ops.fnArray.length).toBeGreaterThan(10)
    await task.destroy()
  })
})
