import type { ImportSheet } from './importDiff'
import type { Cell, Table } from './rows'

// SheetJS is loaded on demand so it stays out of the main bundle.
const loadXlsx = () => import('xlsx')

const DATE_FORMAT = 'yyyy-mm-dd hh:mm'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Excel serial number (in the viewer's local time) for a date. */
export const excelSerial = (d: Date) => (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 25569

function worksheetFor(X: typeof import('xlsx'), t: Table) {
  const aoa: (string | number | null)[][] = [t.header, ...t.data.map(row => row.map((c: Cell) => (c instanceof Date ? excelSerial(c) : c)))]
  const ws = X.utils.aoa_to_sheet(aoa)
  t.data.forEach((row, r) => row.forEach((c, col) => {
    if (c instanceof Date) {
      const cell = ws[X.utils.encode_cell({ r: r + 1, c: col })]
      if (cell) { cell.t = 'n'; cell.z = DATE_FORMAT }
    }
  }))
  ws['!cols'] = t.widths.map(wch => ({ wch }))
  if (t.header.length && t.data.length) ws['!autofilter'] = { ref: X.utils.encode_range({ r: 0, c: 0 }, { r: t.data.length, c: t.header.length - 1 }) }
  return ws
}

/**
 * The community SheetJS build cannot write styles or frozen panes, so patch the generated package:
 * add a bold font/xf to styles.xml, apply it to row 1 of every sheet, and freeze that row.
 * Any failure returns the original bytes (the workbook is still complete, just plain).
 */
export function decorate(X: typeof import('xlsx'), bytes: Uint8Array): Uint8Array {
  try {
    const cfb = X.CFB.read(bytes, { type: 'buffer' })
    const find = (suffix: string) => cfb.FileIndex.findIndex((_: unknown, i: number) => cfb.FullPaths[i].endsWith(suffix))
    const dec = new TextDecoder(), enc = new TextEncoder()
    const read = (i: number) => dec.decode(cfb.FileIndex[i].content as Uint8Array)
    const write = (i: number, xml: string) => {
      const buf = enc.encode(xml)
      cfb.FileIndex[i].content = buf
      cfb.FileIndex[i].size = buf.length
    }
    const si = find('xl/styles.xml')
    if (si < 0) return bytes
    let styles = read(si)
    const fonts = /<fonts count="(\d+)"[^>]*>/.exec(styles), xfs = /<cellXfs count="(\d+)">/.exec(styles)
    if (!fonts || !xfs || !styles.includes('</fonts>') || !styles.includes('</cellXfs>')) return bytes
    const fontId = +fonts[1], xfId = +xfs[1]
    styles = styles
      .replace(fonts[0], fonts[0].replace(`count="${fontId}"`, `count="${fontId + 1}"`))
      .replace('</fonts>', '<font><b/><sz val="12"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>')
      .replace(xfs[0], `<cellXfs count="${xfId + 1}">`)
      .replace('</cellXfs>', `<xf numFmtId="0" fontId="${fontId}" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`)
    write(si, styles)
    cfb.FullPaths.forEach((p: string, i: number) => {
      if (!/xl\/worksheets\/sheet\d+\.xml$/.test(p)) return
      let xml = read(i)
      xml = xml.replace(/<row r="1"[^>]*>[\s\S]*?<\/row>/, row => row.replace(/<c r=/g, `<c s="${xfId}" r=`))
      xml = xml.replace(/<sheetView([^>]*?)\/>/, '<sheetView$1><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView>')
      write(i, xml)
    })
    return X.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }) as Uint8Array
  } catch {
    return bytes
  }
}

/** Builds the workbook and hands it to the browser as a download. */
export async function downloadWorkbook(tables: Table[], fileName: string) {
  const X = await loadXlsx()
  const wb = X.utils.book_new()
  for (const t of tables) X.utils.book_append_sheet(wb, worksheetFor(X, t), t.name)
  const plain = new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
  const bytes = decorate(X, plain)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: XLSX_MIME }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** Every sheet of a workbook as rows of cells (dates come back as Date objects). */
export async function readWorkbook(file: File): Promise<ImportSheet[]> {
  const X = await loadXlsx()
  const wb = X.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  return wb.SheetNames.map(name => ({
    name,
    rows: X.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false }),
  }))
}
