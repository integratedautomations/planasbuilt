import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup, SymbolSet } from '../markups/types'
import { buildRows } from '../schedule/rows'
import { buildReport } from './report'
import {
  DEFAULT_REPORT_OPTIONS, deviceCounts, groupRows, limitPhotos, normalizeReportOptions, pageRangeError, photoGrid, rememberableOptions, reportPages, rowIncluded, visiblePairs,
} from './reportOptions'
import type { ReportOptions } from './reportOptions'
import { effectivePrefs, sanitizeStored } from '../prefs/prefs'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
const sets: SymbolSet[] = [
  { id: 's1', name: 'Cameras', color: '#1971c2', tag_prefix: 'CAM', icon: '', has_fov: false, sort: 0, fields: [] },
  { id: 's2', name: 'Fire', color: '#e03131', tag_prefix: 'FA', icon: '', has_fov: false, sort: 1, fields: [] },
]
const setMap = new Map(sets.map(s => [s.id, s]))
const dev = (id: string, setId: string, page: number, status: Markup['status'], x: number, extra: Partial<Markup> = {}): Markup => ({
  id, document_id: 'doc1', page, type: 'device', text: '', layer_id: null, symbol_set_id: setId, tag: id.toUpperCase(), status, fields: {},
  style: DEFAULT_STYLE, geometry: { x, y: 50, width: 28, height: 28, rotation: 0 }, ...extra,
})
const area = (id: string, name: string, x: number): Markup => ({ id, document_id: 'doc1', page: 1, type: 'area', text: name, layer_id: null, style: DEFAULT_STYLE,
  geometry: { x, y: 0, rotation: 0, points: [0, 0, 100, 0, 100, 400, 0, 400] } })
const markups = [area('a1', 'Lobby', 0), area('a2', 'Hall', 150), dev('c1', 's1', 1, 'installed', 20), dev('c2', 's1', 1, 'planned', 170), dev('f1', 's2', 2, '', 20), dev('f2', 's2', 2, 'punch', 30)]
const rows = buildRows(markups, { symbolSets: setMap, docNames: new Map([['doc1', 'E-101']]) }).filter(r => r.isDevice)
const counts = new Map([['doc1', 3]])
const opts = (o: Partial<ReportOptions>): ReportOptions => ({ ...DEFAULT_REPORT_OPTIONS, ...o })

async function sheet(pages: number) {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([612, 792])
  return d.save()
}

describe('report options', () => {
  it('normalizes saved junk and keeps good values', () => {
    expect(normalizeReportOptions(null)).toEqual(DEFAULT_REPORT_OPTIONS)
    const n = normalizeReportOptions({ photos: 'first', photosPerPage: 6, groupBy: 'area', date: '2026-05-01', statuses: ['planned'], includeBom: true, address: 5, docIds: [1] })
    expect(n).toMatchObject({ photos: 'first', photosPerPage: 6, groupBy: 'area', date: '2026-05-01', statuses: ['planned'], includeBom: true, address: '', docIds: null })
    expect(normalizeReportOptions({ photos: 'many', photosPerPage: 5, groupBy: 'x', date: 'soon' })).toMatchObject({ photos: 'all', photosPerPage: 4, groupBy: 'sheet', date: '' })
  })
  it('is remembered through the prefs store, minus project specific choices', () => {
    const remembered = rememberableOptions(opts({ photos: 'none', docIds: ['doc1'], setIds: ['s1'], pageRanges: { doc1: '1' }, companyName: 'ACME' }))
    expect(remembered).toMatchObject({ photos: 'none', docIds: null, setIds: [], pageRanges: {}, companyName: 'ACME' })
    const back = effectivePrefs(sanitizeStored({ data: { reportOptions: remembered }, stamps: { reportOptions: 1 } })).reportOptions
    expect(normalizeReportOptions(back).companyName).toBe('ACME')
  })
  it('picks pages of a plan and validates ranges', () => {
    expect(reportPages(opts({}), 'doc1', 3)).toEqual([1, 2, 3])
    expect(reportPages(opts({ pageRanges: { doc1: '2-3' } }), 'doc1', 3)).toEqual([2, 3])
    expect(reportPages(opts({ pageRanges: { doc1: '9' } }), 'doc1', 3)).toEqual([1, 2, 3])
    expect(pageRangeError('9', 3)).toMatch(/3 pages/)
    expect(pageRangeError('', 3)).toBe('')
  })
  it('filters devices by plan, page, status and symbol set', () => {
    const ids = (o: Partial<ReportOptions>) => rows.filter(r => rowIncluded(r, opts(o), counts)).map(r => r.tag)
    expect(ids({})).toHaveLength(4)
    expect(ids({ statuses: ['planned', 'punch'] })).toEqual(['C2', 'F2'])
    expect(ids({ statuses: ['none'] })).toEqual(['F1'])
    expect(ids({ setIds: ['s2'] })).toEqual(['F1', 'F2'])
    expect(ids({ pageRanges: { doc1: '2' } })).toEqual(['F1', 'F2'])
    expect(ids({ docIds: ['other'] })).toEqual([])
  })
  it('groups by area, set or sheet', () => {
    expect(groupRows(rows, 'set').map(g => [g.title, g.rows.length])).toEqual([['Cameras', 2], ['Fire', 2]])
    expect(groupRows(rows, 'area').map(g => g.title)).toEqual(['Lobby', 'Hall', 'No area'].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
    expect(groupRows(rows, 'sheet').map(g => g.title)).toHaveLength(2)
  })
  it('limits photos, lays out the grid, hides empty fields and counts devices', () => {
    expect(limitPhotos([1, 2, 3], 'none')).toEqual([])
    expect(limitPhotos([1, 2, 3], 'first')).toEqual([1])
    expect(limitPhotos([1, 2, 3], 'all')).toEqual([1, 2, 3])
    expect([2, 4, 6].map(n => photoGrid(n as 2 | 4 | 6))).toEqual([{ cols: 1, rows: 2 }, { cols: 2, rows: 2 }, { cols: 2, rows: 3 }])
    expect(visiblePairs([['A', 'x'], ['B', '-'], ['C', ' ']], false)).toEqual([['A', 'x']])
    expect(visiblePairs([['B', '-']], true)).toEqual([['B', '-']])
    expect(deviceCounts(rows)).toEqual([{ label: 'Cameras', count: 2 }, { label: 'Fire', count: 2 }])
  })
})

describe('report with options', () => {
  const base = async () => ({
    projectName: 'School', date: new Date('2026-03-01T12:00:00Z'),
    sheets: [{ documentId: 'doc1', name: 'E-101', pdfBytes: await sheet(3), scales: new Map<number, number>() }],
    markups, symbolSets: setMap, photosFor: async () => [1, 2, 3, 4, 5, 6, 7].map(n => ({ bytes: PNG, caption: `P${n}` })),
  })
  const pages = async (o: Partial<ReportOptions>) => (await PDFDocument.load(await buildReport({ ...(await base()), options: opts(o) }))).getPageCount()

  it('can drop the title page, sheets and device pages', async () => {
    expect(await pages({ photos: 'none' })).toBe(1 + 3 + 4)
    expect(await pages({ photos: 'none', titlePage: false })).toBe(3 + 4)
    expect(await pages({ photos: 'none', includeSheets: false })).toBe(1 + 4)
    expect(await pages({ photos: 'none', includeDevices: false })).toBe(1 + 3)
  })
  it('selects pages and filters devices', async () => {
    expect(await pages({ photos: 'none', pageRanges: { doc1: '1' } })).toBe(1 + 1 + 2) // page 1 holds C1 and C2 only
    expect(await pages({ photos: 'none', statuses: ['punch'] })).toBe(1 + 3 + 1)
    expect(await pages({ photos: 'none', setIds: ['s1'], includeSheets: false })).toBe(1 + 2)
  })
  it('limits photos and uses the photos per page setting', async () => {
    // 4 devices with 7 photos each: first only = no extra pages
    expect(await pages({ photos: 'first', includeSheets: false, titlePage: false })).toBe(4)
    const four = await pages({ photos: 'all', photosPerPage: 4, includeSheets: false, titlePage: false })
    const six = await pages({ photos: 'all', photosPerPage: 6, includeSheets: false, titlePage: false })
    const two = await pages({ photos: 'all', photosPerPage: 2, includeSheets: false, titlePage: false })
    expect(six).toBeLessThanOrEqual(four)
    expect(two).toBeGreaterThanOrEqual(four)
  })
  it('adds summary pages for the device counts and BOM', async () => {
    expect(await pages({ photos: 'none', includeLegend: true })).toBe(1 + 1 + 3 + 4)
    expect(await pages({ photos: 'none', includeLegend: true, includeBom: true })).toBe(1 + 2 + 3 + 4)
  })
  it('still makes a page when nothing is selected', async () => {
    expect(await pages({ titlePage: false, includeSheets: false, includeDevices: false })).toBe(1)
  })
})
