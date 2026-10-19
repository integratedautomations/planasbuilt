import { describe, expect, it } from 'vitest'
import * as X from 'xlsx'
import { decorate, excelSerial } from './xlsxIO'

describe('decorate', () => {
  it('adds a bold header and frozen pane and the workbook still reads back', () => {
    const ws = X.utils.aoa_to_sheet([['Tag', 'Updated'], ['CAM-1', excelSerial(new Date(2026, 0, 2, 10, 30))]])
    ws['B2'].z = 'yyyy-mm-dd hh:mm'
    const wb = X.utils.book_new()
    X.utils.book_append_sheet(wb, ws, 'All devices')
    const plain = new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    const out = decorate(X, plain)
    expect(out).not.toBe(plain)
    const cfb = X.CFB.read(out, { type: 'buffer' })
    const get = (suffix: string) => {
      const i = cfb.FullPaths.findIndex((p: string) => p.endsWith(suffix))
      return new TextDecoder().decode(cfb.FileIndex[i].content)
    }
    expect(get('xl/styles.xml')).toContain('<b/>')
    expect(get('xl/worksheets/sheet1.xml')).toContain('state="frozen"')
    expect(get('xl/worksheets/sheet1.xml')).toMatch(/<c s="\d+" r="A1"/)
    const back = X.read(out, { type: 'buffer', cellDates: true })
    const rows = X.utils.sheet_to_json<unknown[]>(back.Sheets['All devices'], { header: 1, raw: true })
    expect(rows[1][0]).toBe('CAM-1')
    expect(rows[1][1]).toBeInstanceOf(Date)
  })
})
