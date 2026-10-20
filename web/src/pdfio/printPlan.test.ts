import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup } from '../markups/types'
import { effectivePrefs, sanitizeStored } from '../prefs/prefs'
import {
  buildPrintHtml, DEFAULT_PRINT_OPTIONS, markupsForPrint, MAX_PRINT_PIXELS, normalizePrintOptions, pageOrientation, planPrint, planRaster, printPageList, QUALITY_DPI,
} from './printPlan'

const m = (id: string, extra: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd', page: 1, type: 'rect', text: '', layer_id: null, style: DEFAULT_STYLE, geometry: { x: 0, y: 0, width: 5, height: 5, rotation: 0 }, ...extra,
})

describe('print page list', () => {
  it('covers all, current, custom and selected pages', () => {
    expect(printPageList({ range: 'all', custom: '' }, 2, 3)).toEqual({ pages: [1, 2, 3] })
    expect(printPageList({ range: 'current', custom: '' }, 2, 3)).toEqual({ pages: [2] })
    expect(printPageList({ range: 'custom', custom: '1,3' }, 2, 3)).toEqual({ pages: [1, 3] })
    expect(printPageList({ range: 'custom', custom: '7' }, 2, 3).error).toBeTruthy()
    expect(printPageList({ range: 'selected', custom: '' }, 1, 5, [4, 2, 2, 9])).toEqual({ pages: [2, 4] })
    expect(printPageList({ range: 'selected', custom: '' }, 1, 5, []).error).toMatch(/Pages panel/)
  })
})

describe('print raster planning', () => {
  it('picks dpi from the quality setting and converts points to pixels', () => {
    const r = planRaster(612, 792, 'normal')
    expect(r.dpi).toBe(QUALITY_DPI.normal)
    expect(r).toMatchObject({ pxWidth: 1700, pxHeight: 2200 })
    expect(planRaster(612, 792, 'high').pxWidth).toBe(2550)
    expect(planRaster(612, 792, 'draft').pxWidth).toBe(1275)
  })
  it('caps big sheets so memory stays bounded', () => {
    const r = planRaster(36 * 72, 48 * 72, 'high') // 36 x 48 in at 300 dpi would be 155 MP
    expect(r.pxWidth * r.pxHeight).toBeLessThanOrEqual(MAX_PRINT_PIXELS * 1.001)
    expect(r.dpi).toBeLessThan(300)
    expect(r.dpi).toBeGreaterThan(100)
  })
  it('follows the sheet shape in automatic orientation, or the fixed choice', () => {
    expect(pageOrientation(792, 612, 'auto')).toBe('landscape')
    expect(pageOrientation(612, 792, 'auto')).toBe('portrait')
    expect(pageOrientation(612, 792, 'landscape')).toBe('landscape')
    const plans = planPrint([1, 2], new Map([[1, { width: 792, height: 612 }], [2, { width: 612, height: 792 }]]), { orientation: 'auto', quality: 'draft' })
    expect(plans.map(p => [p.page, p.orientation, p.widthIn, p.heightIn])).toEqual([[1, 'landscape', 11, 8.5], [2, 'portrait', 8.5, 11]])
  })
})

describe('print markups and options', () => {
  const list = [m('a'), m('b', { layer_id: 'L1' }), m('c', { type: 'legend' })]
  it('applies layers, legends and the markups switch', () => {
    const base = { includeMarkups: true, hiddenLayers: [] as string[], includeLegend: true }
    expect(markupsForPrint(list, base)?.map(x => x.id)).toEqual(['a', 'b', 'c'])
    expect(markupsForPrint(list, { ...base, hiddenLayers: ['L1'] })?.map(x => x.id)).toEqual(['a', 'c'])
    expect(markupsForPrint(list, { ...base, includeLegend: false })?.map(x => x.id)).toEqual(['a', 'b'])
    expect(markupsForPrint(list, { ...base, includeMarkups: false })).toBeUndefined()
  })
  it('normalizes saved options and keeps them in the prefs', () => {
    expect(normalizePrintOptions(undefined)).toEqual(DEFAULT_PRINT_OPTIONS)
    expect(normalizePrintOptions({ quality: 'high', orientation: 'sideways', margins: 'none', grayscale: true })).toMatchObject({ quality: 'high', orientation: 'auto', margins: 'none', grayscale: true })
    const stored = sanitizeStored({ data: { printOptions: { quality: 'draft' } }, stamps: { printOptions: 2 } })
    expect(normalizePrintOptions(effectivePrefs(stored).printOptions).quality).toBe('draft')
  })
})

describe('print document', () => {
  const plan = (page: number, orientation: 'portrait' | 'landscape') => ({ page, orientation, widthIn: 24, heightIn: 36, pxWidth: 10, pxHeight: 10, dpi: 200, scale: 2.7 })
  const imgs = [{ src: 'blob:a', plan: plan(1, 'landscape') }, { src: 'blob:b', plan: plan(2, 'portrait') }]
  it('lets the printer choose the paper: size auto, margins from the setting, one sheet per image', () => {
    const html = buildPrintHtml(imgs, { fit: true, margins: 'narrow', orientation: 'auto', grayscale: false })
    expect(html).toContain('@page { size: auto; margin: 0.25in; }')
    expect(html).toContain('@page land { size: landscape; margin: 0.25in; }')
    expect(html).toContain('@page port { size: portrait; margin: 0.25in; }')
    expect(html.match(/class="sheet /g)).toHaveLength(2)
    expect(html).toContain('class="sheet fit landscape"><img src="blob:a"')
    expect(html).toContain('object-fit: contain')
    expect(html).not.toContain('grayscale')
  })
  it('uses a fixed orientation and actual size from the page points', () => {
    const html = buildPrintHtml(imgs, { fit: false, margins: 'none', orientation: 'landscape', grayscale: true })
    expect(html).toContain('@page { size: landscape; margin: 0in; }')
    expect(html).not.toContain('@page land')
    expect(html).toContain('style="width:24in;height:36in"')
    expect(html).toContain('filter: grayscale(1)')
  })
  it('escapes the title', () => {
    expect(buildPrintHtml([], { fit: true, margins: 'normal', orientation: 'auto', grayscale: false }, '<b>"x"</b>')).toContain('<title>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</title>')
  })
})
