import { PDFArray, PDFDocument, PDFName, PDFDict, PrintScaling } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup } from '../markups/types'
import { buildSubset, parsePageRange } from './pageSubset'
import { printableMarkups, printPages } from './printOptions'

async function makePdf(widths: number[]) {
  const doc = await PDFDocument.create()
  for (const w of widths) doc.addPage([w, 200])
  return doc.save()
}
const rect = (id: string, page: number, extra: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd', page, type: 'rect', text: '', layer_id: null, style: { ...DEFAULT_STYLE },
  geometry: { x: 10, y: 10, width: 40, height: 30, rotation: 0 }, ...extra,
})
const annotCount = (doc: PDFDocument, i: number) => {
  const a = doc.getPage(i).node.lookup(PDFName.of('Annots'))
  return a instanceof PDFArray ? a.size() : 0
}

describe('parsePageRange', () => {
  it('reads lists and ranges', () => {
    expect(parsePageRange('1-3, 5', 8)).toEqual({ pages: [1, 2, 3, 5] })
    expect(parsePageRange('5,1,1', 8)).toEqual({ pages: [1, 5] })
  })
  it('explains what is wrong', () => {
    expect(parsePageRange('', 8).error).toBeTruthy()
    expect(parsePageRange('x', 8).error).toMatch(/not a page/)
    expect(parsePageRange('3-1', 8).error).toMatch(/range/)
    expect(parsePageRange('9', 8).error).toMatch(/8 pages/)
    expect(parsePageRange('0', 8).error).toBeTruthy()
  })
})

describe('print options', () => {
  it('chooses pages from the range setting', () => {
    expect(printPages({ range: 'all', custom: '' }, 2, 3)).toEqual({ pages: [1, 2, 3] })
    expect(printPages({ range: 'current', custom: '' }, 2, 3)).toEqual({ pages: [2] })
    expect(printPages({ range: 'custom', custom: '1,3' }, 2, 3)).toEqual({ pages: [1, 3] })
    expect(printPages({ range: 'custom', custom: '7' }, 2, 3).error).toBeTruthy()
  })
  it('drops markups on unchecked layers and symbol sets', () => {
    const ms = [rect('a', 1), rect('b', 1, { layer_id: 'L1' }), rect('c', 1, { symbol_set_id: 'S1' })]
    expect(printableMarkups(ms, []).map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(printableMarkups(ms, ['L1']).map(m => m.id)).toEqual(['a', 'c'])
    expect(printableMarkups(ms, ['', 'set:S1']).map(m => m.id)).toEqual(['b'])
  })
})

describe('buildSubset', () => {
  it('keeps only the chosen pages and renumbers their markups', async () => {
    const src = await makePdf([100, 200, 300])
    const out = await PDFDocument.load(await buildSubset({
      pdfBytes: src, pages: [3, 1], markups: [rect('a', 1), rect('b', 2), rect('c', 3), rect('d', 3)], mode: 'annotate',
    }))
    expect(out.getPages().map(p => p.getWidth())).toEqual([300, 100])
    expect(annotCount(out, 0)).toBe(2)
    expect(annotCount(out, 1)).toBe(1)
  })

  it('copies pages plain when no markups are given', async () => {
    const out = await PDFDocument.load(await buildSubset({ pdfBytes: await makePdf([100, 200]), pages: [2] }))
    expect(out.getPageCount()).toBe(1)
    expect(annotCount(out, 0)).toBe(0)
  })

  it('flattens markups into the page instead of adding annotations', async () => {
    const out = await PDFDocument.load(await buildSubset({ pdfBytes: await makePdf([100]), pages: [1], markups: [rect('a', 1)], mode: 'flatten' }))
    expect(annotCount(out, 0)).toBe(0)
    const contents = out.getPage(0).node.lookup(PDFName.of('Contents'))
    expect(contents).toBeDefined()
  })

  it('sets the viewer print scaling for fit versus actual size', async () => {
    const scaling = async (fit: boolean) => {
      const out = await PDFDocument.load(await buildSubset({ pdfBytes: await makePdf([100]), pages: [1], fitToPage: fit }))
      return out.catalog.getOrCreateViewerPreferences().getPrintScaling()
    }
    expect(await scaling(false)).toBe(PrintScaling.None)
    expect(await scaling(true)).toBe(PrintScaling.AppDefault)
    const untouched = await PDFDocument.load(await buildSubset({ pdfBytes: await makePdf([100]), pages: [1] }))
    expect(untouched.catalog.lookup(PDFName.of('ViewerPreferences')) instanceof PDFDict).toBe(false)
  })

  it('rejects pages the plan does not have', async () => {
    await expect(buildSubset({ pdfBytes: await makePdf([100]), pages: [2] })).rejects.toThrow()
    await expect(buildSubset({ pdfBytes: await makePdf([100]), pages: [] })).rejects.toThrow()
  })
})
