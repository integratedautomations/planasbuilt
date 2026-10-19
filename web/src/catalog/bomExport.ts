import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { downloadBytes } from '../pdfio/download'
import { sanitizeText, wrapText } from '../pdfio/stream'
import { autoWidths } from '../schedule/rows'
import type { Cell, Table } from '../schedule/rows'
import { bomTable, hours, money } from './bom'
import type { Bom } from './bom'

/** The BOM as an Excel sheet: header, rows and a totals row. */
export function bomWorkbookTable(bom: Bom): Table {
  const t = bomTable(bom)
  const data: Cell[][] = [...t.rows, t.totals].map(r => r.map(c => (c === '' ? null : c)))
  return { name: 'BOM', header: t.header, data, widths: autoWidths(t.header, data) }
}

export async function downloadBomExcel(bom: Bom, fileName: string) {
  const { downloadWorkbook } = await import('../schedule/xlsxIO')
  await downloadWorkbook([bomWorkbookTable(bom)], fileName)
}

export interface BomPdfInfo { projectName: string; scope: string; date: Date }

const W = 792, H = 612, M = 36 // landscape letter

/** A tidy landscape PDF of the BOM: title block, table that paginates, totals row. */
export async function buildBomPdf(bom: Bom, info: BomPdfInfo): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const text = (page: ReturnType<typeof doc.addPage>, s: string, x: number, y: number, size: number, b = false, right = 0) => {
    const t = sanitizeText(s)
    const f = b ? bold : font
    let w = 0
    if (right) { try { w = f.widthOfTextAtSize(t, size) } catch { w = t.length * size * 0.55 } }
    page.drawText(t, { x: right ? right - w : x, y, size, font: f, color: rgb(0, 0, 0) })
  }
  const width = (s: string, size: number) => { try { return font.widthOfTextAtSize(sanitizeText(s), size) } catch { return s.length * size * 0.55 } }

  // columns: label, x, width, right aligned
  const cols = [
    { h: 'Item', x: M, w: 330 }, { h: 'Qty', x: M + 330, w: 40, r: true }, { h: 'Unit cost', x: M + 370, w: 80, r: true },
    { h: 'Ext cost', x: M + 450, w: 90, r: true }, { h: 'Labor hrs', x: M + 540, w: 70, r: true }, { h: 'Ext labor', x: M + 610, w: 70, r: true },
  ]
  let page = doc.addPage([W, H])
  let y = H - M
  text(page, 'Bill of Materials', M, y - 16, 20, true)
  text(page, info.projectName, M, y - 36, 12)
  text(page, `${info.scope}  |  ${info.date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, M, y - 50, 9)
  y -= 74
  const header = () => {
    for (const c of cols) text(page, c.h, c.x, y, 9, true, c.r ? c.x + c.w : 0)
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) })
    y -= 16
  }
  const ensure = (h: number) => {
    if (y - h < M + 24) { page = doc.addPage([W, H]); y = H - M; header() }
  }
  header()
  const sectionNames = { devices: 'Devices', accessories: 'Accessories', unassigned: 'Unassigned devices' } as const
  let section = ''
  for (const l of bom.lines) {
    if (l.section !== section) {
      section = l.section
      ensure(30)
      y -= 4
      text(page, sectionNames[l.section], M, y, 10, true)
      y -= 14
    }
    const item = [l.manufacturer, l.model].filter(Boolean).join(' ')
    const lines = wrapText([item, l.name && l.name !== l.model ? l.name : ''].filter(Boolean).join(' - ') || l.name, 9, cols[0].w - 6, width)
    const h = Math.max(1, lines.length) * 11 + 2
    ensure(h)
    lines.forEach((ln, i) => text(page, ln, cols[0].x, y - i * 11, 9))
    const vals = [String(l.qty), l.section === 'unassigned' ? '' : money(l.unitCost), l.section === 'unassigned' ? '' : money(l.extCost),
      l.section === 'unassigned' ? '' : hours(l.laborHours), l.section === 'unassigned' ? '' : hours(l.extLabor)]
    vals.forEach((v, i) => { const c = cols[i + 1]; if (v) text(page, v, c.x, y, 9, false, c.x + c.w) })
    y -= h
  }
  ensure(24)
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) })
  y -= 8
  text(page, 'Total', cols[0].x, y, 10, true)
  const tv = [String(bom.totals.qty), '', money(bom.totals.cost), '', hours(bom.totals.labor)]
  tv.forEach((v, i) => { const c = cols[i + 1]; if (v) text(page, v, c.x, y, 10, true, c.x + c.w) })
  return doc.save()
}

export async function downloadBomPdf(bom: Bom, info: BomPdfInfo, fileName: string) {
  downloadBytes(await buildBomPdf(bom, info), fileName)
}

export function bomFileName(projectName: string, ext: 'xlsx' | 'pdf', now = new Date()): string {
  const safe = projectName.replace(/[\/:*?"<>|]/g, '-').trim() || 'Project'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${safe} - BOM - ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.${ext}`
}
