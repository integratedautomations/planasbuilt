import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont, PDFPage } from 'pdf-lib'
import { scaleDevices } from '../markups/deviceScale'
import { naturalCompare } from '../markups/stacks'
import { HARDWARE_FIELDS } from '../markups/types'
import { EMPTY_CATALOG, fieldDefsFor } from '../catalog/catalog'
import { computeBom, hours, money } from '../catalog/bom'
import type { Catalog } from '../catalog/catalog'
import type { DeviceType } from '../catalog/types'
import type { Markup, SymbolSet } from '../markups/types'
import { buildRows, fieldText } from '../schedule/rows'
import type { ScheduleRow } from '../schedule/rows'
import { applyMarkups, prepareResources } from './build'
import type { ExportInput } from './build'
import { hexToRgb, sanitizeText, wrapText } from './stream'
import { DEFAULT_REPORT_OPTIONS, deviceCounts, groupRows, limitPhotos, photoGrid, reportPages, rowIncluded, visiblePairs } from './reportOptions'
import type { ReportOptions } from './reportOptions'

export interface ReportPhoto { bytes: Uint8Array; caption: string }

export interface ReportSheet {
  documentId: string
  name: string
  pdfBytes: ArrayBuffer | Uint8Array
  /** Points per foot by page (1-based). */
  scales: Map<number, number>
  /** Device size multiplier of this plan (default 1). */
  deviceScale?: number
}

export interface ReportInput {
  projectName: string
  date: Date
  sheets: ReportSheet[]
  /** Every markup of the project (areas are used for area paths). */
  markups: Markup[]
  symbolSets: Map<string, SymbolSet>
  /** Device types and products for the Type / Product lines. */
  catalog?: Catalog
  icons?: Map<string, Uint8Array>
  /** Photos for a device (annotated versions preferred by the caller). */
  photosFor: (markupId: string) => Promise<ReportPhoto[]>
  /** What the report dialog asked for (defaults to everything). */
  options?: ReportOptions
  onProgress?: (done: number, total: number, label: string) => void
}

const W = 612, H = 792, MARGIN = 48
const GRAY = rgb(0.4, 0.4, 0.4)
const BLACK = rgb(0, 0, 0)

const dateText = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
const shortDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US') }

/** Label/value pairs shown for a device (all of its fields, empty ones as a dash). */
export function deviceRows(r: ScheduleRow, set: SymbolSet | undefined, type?: DeviceType): [string, string][] {
  const out: [string, string][] = [
    ['Tag', r.tag || '-'],
    ['Symbol set', r.setName || '-'],
    ['Device type', r.typeName || '-'],
    ['Product', r.productName || '-'],
    ['Status', r.statusLabel || '-'],
    ['Area', r.areaText || '-'],
    ['Sheet', r.sheet || '-'],
    ['Placed by', [r.placedBy, r.placedAt && shortDate(r.placedAt)].filter(Boolean).join(' on ') || '-'],
    ['Last updated by', [r.editedBy, r.editedAt && shortDate(r.editedAt)].filter(Boolean).join(' on ') || '-'],
  ]
  for (const f of [...fieldDefsFor(set, type), ...HARDWARE_FIELDS]) out.push([f.label, fieldText(r.fields[f.key]) || '-'])
  if (r.markup.text) out.push(['Notes', r.markup.text])
  return out
}

function imageKind(b: Uint8Array): 'jpg' | 'png' | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (b[0] === 0x89 && b[1] === 0x50) return 'png'
  return null
}

class Writer {
  page!: PDFPage
  y = 0
  doc: PDFDocument
  font: PDFFont
  bold: PDFFont
  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont) { this.doc = doc; this.font = font; this.bold = bold }
  newPage() { this.page = this.doc.addPage([W, H]); this.y = H - MARGIN; return this.page }
  width(s: string, size: number, bold = false) {
    try { return (bold ? this.bold : this.font).widthOfTextAtSize(sanitizeText(s), size) } catch { return s.length * size * 0.55 }
  }
  text(s: string, x: number, y: number, size: number, o: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    this.page.drawText(sanitizeText(s), { x, y, size, font: o.bold ? this.bold : this.font, color: o.color ?? BLACK })
  }
}

/** Builds the as-built report: title page, optional summaries, flattened sheets, then one section per device. */
export async function buildReport(input: ReportInput): Promise<Uint8Array> {
  const opts = input.options ?? DEFAULT_REPORT_OPTIONS
  const out = await PDFDocument.create()
  const w = new Writer(out, await out.embedFont(StandardFonts.Helvetica), await out.embedFont(StandardFonts.HelveticaBold))
  const scaleFor = (docId: string, page: number) => input.sheets.find(s => s.documentId === docId)?.scales.get(page) ?? null
  const sheets = opts.docIds ? input.sheets.filter(s => opts.docIds!.includes(s.documentId)) : input.sheets
  const pageCounts = new Map<string, number>()
  for (const s of sheets) pageCounts.set(s.documentId, (await PDFDocument.load(s.pdfBytes, { ignoreEncryption: true })).getPageCount())
  const allRows = buildRows(input.markups, {
    symbolSets: input.symbolSets, catalog: input.catalog, docNames: new Map(input.sheets.map(s => [s.documentId, s.name])), scaleFor,
  }).filter(r => r.isDevice)
  const sheetOrder = new Map(input.sheets.map((s, i) => [s.documentId, i]))
  allRows.sort((a, b) => (sheetOrder.get(a.documentId) ?? 0) - (sheetOrder.get(b.documentId) ?? 0) || a.page - b.page || naturalCompare(a.tag, b.tag))
  const filtered = allRows.filter(r => rowIncluded(r, opts, pageCounts))
  const groups = groupRows(filtered, opts.groupBy)
  const rows = opts.includeDevices ? groups.flatMap(g => g.rows) : []
  const groupOf = new Map<string, string>()
  for (const g of groups) for (const r of g.rows) groupOf.set(r.id, g.title)
  const sheetPages = (s: ReportSheet) => reportPages(opts, s.documentId, pageCounts.get(s.documentId) ?? 0)
  const shownSheets = opts.includeSheets ? sheets : []
  const total = shownSheets.length + rows.length
  let done = 0
  const tick = (label: string) => input.onProgress?.(++done, total, label)

  // ---- title page
  if (opts.titlePage) {
    w.newPage()
    w.text('As-Built Report', MARGIN, H - 200, 34, { bold: true })
    w.text(input.projectName, MARGIN, H - 245, 22)
    let ty = H - 275
    if (opts.address.trim()) {
      for (const ln of wrapText(opts.address, 13, W - 2 * MARGIN, (s, z) => w.width(s, z))) { w.text(ln, MARGIN, ty, 13); ty -= 17 }
      ty -= 4
    }
    w.text(dateText(opts.date ? new Date(`${opts.date}T12:00:00`) : input.date), MARGIN, ty, 13, { color: GRAY })
    ty -= 30
    if (opts.companyName.trim()) { w.text(opts.companyName, MARGIN, ty, 14, { bold: true }); ty -= 20 }
    if (opts.preparedBy.trim()) { w.text(`Prepared by ${opts.preparedBy}`, MARGIN, ty, 12, { color: GRAY }); ty -= 20 }
    let y = Math.min(ty - 24, H - 330)
    w.text(`${shownSheets.length} sheet${shownSheets.length === 1 ? '' : 's'}  |  ${filtered.length} device${filtered.length === 1 ? '' : 's'}`, MARGIN, y, 12, { color: GRAY })
    y -= 30
    if (shownSheets.length) { w.text('Sheets', MARGIN, y, 13, { bold: true }); y -= 20 }
    for (const s of shownSheets) {
      if (y < MARGIN) { w.newPage(); y = H - MARGIN }
      const n = filtered.filter(r => r.documentId === s.documentId).length
      w.text(`${s.name}`, MARGIN, y, 11)
      w.text(`${n} device${n === 1 ? '' : 's'}`, W - MARGIN - 80, y, 11, { color: GRAY })
      y -= 16
    }
  }

  // ---- summaries: device counts and bill of materials
  const table = (title: string, header: string[], body: string[][], widths: number[]) => {
    w.newPage()
    w.text(title, MARGIN, w.y - 12, 18, { bold: true })
    w.y -= 38
    const line = (cells: string[], bold = false) => {
      if (w.y < MARGIN + 14) { w.newPage(); w.y = H - MARGIN }
      let x = MARGIN
      cells.forEach((c, i) => {
        const t = wrapText(c, 10, widths[i] - 6, (s, z) => w.width(s, z, bold))[0] ?? ''
        const right = i >= cells.length - (header.length > 3 ? 3 : 1) && /^[\d$.,\-]+$/.test(c)
        w.text(t, right ? x + widths[i] - 6 - w.width(t, 10, bold) : x, w.y, 10, { bold, color: bold ? GRAY : BLACK })
        x += widths[i]
      })
      w.y -= 15
    }
    line(header, true)
    for (const r of body) line(r)
  }
  if (opts.includeLegend) {
    const counts = deviceCounts(filtered)
    table('Device summary', ['Device', 'Count'], [...counts.map(c => [c.label, String(c.count)]), ['Total', String(filtered.length)]], [W - 2 * MARGIN - 80, 80])
  }
  if (opts.includeBom) {
    const cat = input.catalog ?? EMPTY_CATALOG
    const bom = computeBom(filtered.map(r => ({ setId: r.setId, typeId: r.typeId || null, productId: r.productId || null, documentId: r.documentId, areaPath: r.areaPath })), cat, input.symbolSets)
    const body = bom.lines.map(l => [l.group, [l.manufacturer, l.model].filter(Boolean).join(' ') || l.name, String(l.qty), money(l.extCost), hours(l.extLabor)])
    body.push(['Total', '', String(bom.totals.qty), money(bom.totals.cost), hours(bom.totals.labor)])
    table('Bill of materials', ['Group', 'Item', 'Qty', 'Cost', 'Labor hrs'], body, [150, 190, 40, 70, 66])
  }

  // ---- flattened sheets
  for (const s of shownSheets) {
    const src = await PDFDocument.load(s.pdfBytes, { ignoreEncryption: true })
    const res = await prepareResources(src, input.icons)
    const ex: ExportInput = {
      pdfBytes: s.pdfBytes, markups: scaleDevices(input.markups.filter(m => m.document_id === s.documentId), s.deviceScale ?? 1),
      symbolSets: input.symbolSets, scales: s.scales, icons: input.icons, catalog: input.catalog,
    }
    applyMarkups(src, 'flatten', ex, res)
    const copied = await out.copyPages(src, sheetPages(s).map(p => p - 1))
    copied.forEach(p => out.addPage(p))
    tick(s.name)
  }

  // ---- device pages
  for (const r of rows) {
    const set = r.setId ? input.symbolSets.get(r.setId) : undefined
    const color = hexToRgb(set?.color) ?? [0.3, 0.3, 0.3]
    const grouped = groupOf.get(r.id) ?? ''
    const header = (cont: boolean) => {
      w.newPage()
      w.page.drawRectangle({ x: 0, y: H - 70, width: W, height: 70, color: rgb(color[0], color[1], color[2]) })
      w.text(`${r.tag || set?.tag_prefix || 'Device'}${cont ? ' (continued)' : ''}`, MARGIN, H - 44, 24, { bold: true, color: rgb(1, 1, 1) })
      const sub = opts.groupBy === 'set' ? `${grouped}  |  ${r.sheet}` : opts.groupBy === 'area' ? `${r.setName}  |  ${grouped}  |  ${r.sheet}` : `${r.setName}  |  ${r.sheet}`
      w.text(sub, MARGIN, H - 62, 10, { color: rgb(1, 1, 1) })
      w.y = H - 70 - 28
    }
    header(false)
    const pairs = visiblePairs(deviceRows(r, set, r.typeId ? input.catalog?.types.get(r.typeId) : undefined), opts.includeEmptyFields)
    for (const [label, value] of pairs) {
      const lines = wrapText(value, 10.5, W - 2 * MARGIN - 130, (s, z) => w.width(s, z))
      const h = Math.max(1, lines.length) * 13 + 3
      if (w.y - h < (opts.photos === 'none' ? MARGIN : 220)) { header(true) } // keep room for photos on the first page; spill onto a continuation page
      w.text(label, MARGIN, w.y, 10.5, { bold: true, color: GRAY })
      lines.forEach((ln, i) => w.text(ln, MARGIN + 130, w.y - i * 13, 10.5))
      w.y -= h
    }

    // photos: a grid of 2, 4 or 6 per page
    const photos = opts.photos === 'none' ? [] : limitPhotos(await input.photosFor(r.id).catch(() => [] as ReportPhoto[]), opts.photos)
    const embedded: { img: Awaited<ReturnType<PDFDocument['embedJpg']>>; caption: string }[] = []
    for (const p of photos) {
      const kind = imageKind(p.bytes)
      if (!kind) continue
      try { embedded.push({ img: kind === 'jpg' ? await out.embedJpg(p.bytes) : await out.embedPng(p.bytes), caption: p.caption }) } catch { /* unreadable photo */ }
    }
    if (embedded.length) {
      w.y -= 10
      w.text(`Photos (${embedded.length})`, MARGIN, w.y, 12, { bold: true })
      w.y -= 14
    }
    let i = 0
    const grid = photoGrid(opts.photosPerPage)
    const gap = 14, cellW = (W - 2 * MARGIN - (grid.cols - 1) * gap) / grid.cols
    while (i < embedded.length) {
      if (w.y - MARGIN < 190) { header(true); w.y -= 4 }
      const space = w.y - MARGIN
      let nRows = 1
      for (let n = grid.rows; n > 1; n--) if (space >= 200 * n && embedded.length - i > (n - 1) * grid.cols) { nRows = n; break }
      const cellH = Math.min(300, (space - (nRows - 1) * gap) / nRows) - 16
      for (let row = 0; row < nRows && i < embedded.length; row++) {
        const top = w.y
        for (let col = 0; col < grid.cols && i < embedded.length; col++, i++) {
          const { img, caption } = embedded[i]
          const scale = Math.min(cellW / img.width, cellH / img.height)
          const iw = img.width * scale, ih = img.height * scale
          const x = MARGIN + col * (cellW + gap)
          w.page.drawImage(img, { x: x + (cellW - iw) / 2, y: top - ih, width: iw, height: ih })
          if (caption) w.text(wrapText(caption, 9, cellW, (s, z) => w.width(s, z))[0] ?? '', x, top - ih - 11, 9, { color: GRAY })
        }
        w.y = top - cellH - 16 - gap
      }
    }
    tick(r.tag || r.id)
  }
  if (out.getPageCount() === 0) { w.newPage(); w.text('Nothing to report with these options.', MARGIN, H - 120, 14, { color: GRAY }) }
  return out.save()
}
