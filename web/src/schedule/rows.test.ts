import { describe, expect, it } from 'vitest'
import { areaOptions, buildRows, exportFileName, exportTables, filterRows, listColumns, NO_FILTER, sheetName, sortRows } from './rows'
import type { Markup, SymbolSet } from '../markups/types'

const style = { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }
const sq = (x: number, y: number, s: number) => ({ x, y, rotation: 0, points: [0, 0, s, 0, s, s, 0, s] })
let n = 0
const dev = (tag: string, x: number, y: number, set = 'cam', extra: Partial<Markup> = {}): Markup => ({
  id: `d${++n}`, document_id: 'doc1', page: 1, type: 'device', symbol_set_id: set, tag, status: 'planned',
  geometry: { x, y, width: 20, height: 20, rotation: 0 }, style, text: '', layer_id: null,
  document_name: 'Plans', created_by_name: 'Ann', updated_by_name: 'Bob', created_at: '2026-01-02T10:00:00Z', updated_at: '2026-01-03T10:00:00Z',
  ...extra,
})
const area = (id: string, text: string, x: number, y: number, s: number, fields: Markup['fields'] = {}): Markup => ({
  id, document_id: 'doc1', page: 1, type: 'area', text, geometry: sq(x, y, s), style, layer_id: null, fields,
})
const sets = new Map<string, SymbolSet>([
  ['cam', { id: 'cam', name: 'Cameras', color: '#000', tag_prefix: 'CAM', icon: '', has_fov: true, sort: 1, fields: [{ key: 'ip', label: 'IP', type: 'ip' }, { key: 'res', label: 'Resolution', type: 'text' }] }],
  ['fa', { id: 'fa', name: 'Fire Alarm', color: '#000', tag_prefix: 'FA', icon: '', has_fov: false, sort: 2, fields: [{ key: 'zone', label: 'Zone', type: 'number' }] }],
])
const areas = [
  area('sheet', 'First Floor', 0, 0, 1000, { sheet: true }),
  area('lr', 'Living Room', 0, 0, 200),
]

describe('buildRows', () => {
  const markups = [...areas, dev('CAM-2', 50, 50), dev('CAM-10', 500, 500, 'cam', { fields: { ip: '10.0.0.5' } }), dev('FA-1', 60, 60, 'fa'),
    { id: 'm1', document_id: 'doc1', page: 1, type: 'measure-length', geometry: { x: 0, y: 0, rotation: 0, points: [0, 0, 144, 0] }, style, text: '', layer_id: null } as Markup,
    { id: 't1', document_id: 'doc1', page: 1, type: 'text', geometry: { x: 5, y: 5, width: 10, height: 10, rotation: 0 }, style, text: 'Hello', layer_id: null } as Markup]
  const ctx = { symbolSets: sets, scaleFor: () => 72 }
  it('lists devices only by default and never areas', () => {
    const rows = buildRows(markups, ctx)
    expect(rows.map(r => r.tag).sort()).toEqual(['CAM-10', 'CAM-2', 'FA-1'])
  })
  it('computes area paths per device', () => {
    const rows = buildRows(markups, ctx)
    expect(rows.find(r => r.tag === 'CAM-2')!.areaPath).toEqual(['First Floor', 'Living Room'])
    expect(rows.find(r => r.tag === 'CAM-10')!.areaPath).toEqual(['First Floor'])
  })
  it('shows measurement values and text with show-all', () => {
    const rows = buildRows(markups, { ...ctx, showAll: true })
    expect(rows.find(r => r.id === 'm1')!.value).toBe(`2'-0"`)
    expect(rows.find(r => r.id === 't1')!.value).toBe('Hello')
    expect(rows.some(r => r.type === 'area')).toBe(false)
  })
  it('flags unscaled measurements', () => {
    const rows = buildRows(markups, { symbolSets: sets, showAll: true })
    expect(rows.find(r => r.id === 'm1')!.value).toBe('No scale')
  })
  it('marks stack size', () => {
    const rows = buildRows([dev('CAM-1', 0, 0), dev('CAM-2', 0, 0), dev('CAM-3', 300, 300)], ctx)
    expect(rows.map(r => r.stackSize)).toEqual([2, 2, 1])
  })
})

describe('columns, filter, sort', () => {
  const rows = buildRows([...areas, dev('CAM-2', 50, 50), dev('CAM-10', 500, 500, 'cam', { fields: { ip: '10.0.0.5', res: '4K' }, status: 'installed' }), dev('FA-1', 60, 60, 'fa', { fields: { zone: 3 } })], { symbolSets: sets })
  it('uses set fields when filtered, common hardware + IP otherwise', () => {
    expect(listColumns(rows, sets, 'fa', false).map(c => c.label)).toContain('Zone')
    const all = listColumns(rows, sets, '', false).map(c => c.label)
    expect(all).toEqual(expect.arrayContaining(['Manufacturer', 'Model #', 'Serial #', 'IP']))
    expect(all).not.toContain('Zone')
  })
  it('sorts tags naturally', () => {
    const cols = listColumns(rows, sets, '', false)
    expect(sortRows(rows, cols, 'tag', 'asc').map(r => r.tag)).toEqual(['CAM-2', 'CAM-10', 'FA-1'])
    expect(sortRows(rows, cols, 'tag', 'desc').map(r => r.tag)).toEqual(['FA-1', 'CAM-10', 'CAM-2'])
  })
  it('filters by search, set, status and area', () => {
    expect(filterRows(rows, { ...NO_FILTER, search: '10.0.0' }).map(r => r.tag)).toEqual(['CAM-10'])
    expect(filterRows(rows, { ...NO_FILTER, search: 'living' }).map(r => r.tag).sort()).toEqual(['CAM-2', 'FA-1'])
    expect(filterRows(rows, { ...NO_FILTER, setId: 'fa' })).toHaveLength(1)
    expect(filterRows(rows, { ...NO_FILTER, status: 'installed' }).map(r => r.tag)).toEqual(['CAM-10'])
    expect(filterRows(rows, { ...NO_FILTER, area: 'First Floor' })).toHaveLength(3)
    expect(filterRows(rows, { ...NO_FILTER, area: 'First Floor > Living Room' })).toHaveLength(2)
  })
  it('offers area paths and their parents', () => {
    expect(areaOptions(rows)).toEqual(['First Floor', 'First Floor > Living Room'])
  })
})

describe('export', () => {
  const rows = buildRows([...areas, dev('CAM-2', 50, 50, 'cam', { fields: { ip: '1.1.1.1', manufacturer: 'Axis', notes: 'n' } }), dev('FA-1', 60, 60, 'fa', { fields: { zone: '4' } })], { symbolSets: sets })
  const tables = exportTables(rows, [...sets.values()])
  it('makes All devices, one sheet per set, and Measurements', () => {
    expect(tables.map(t => t.name)).toEqual(['All devices', 'Cameras', 'Fire Alarm', 'Measurements'])
  })
  it('lays out columns with set fields first, id last, split area columns, real dates and numbers', () => {
    const t = tables[1]
    expect(t.header.slice(0, 9)).toEqual(['Tag', 'Set', 'Status', 'Area', 'Area 1', 'Area 2', 'Area 3', 'Document', 'Page'])
    expect(t.header.slice(9, 12)).toEqual(['IP', 'Resolution', 'Manufacturer'])
    expect(t.header.at(-1)).toBe('id')
    const row = t.data[0]
    expect(row[3]).toBe('First Floor > Living Room')
    expect(row[4]).toBe('First Floor'); expect(row[5]).toBe('Living Room'); expect(row[6]).toBeNull()
    expect(t.data[0][t.header.indexOf('Placed at')]).toBeInstanceOf(Date)
    expect(tables[2].data[0][tables[2].header.indexOf('Zone')]).toBe(4)
  })
  it('sanitizes sheet names', () => {
    const taken = new Set<string>()
    expect(sheetName('A/B:C*D?[x]', taken)).toBe('A B C D x')
    expect(sheetName('a b c d x', taken)).toBe('a b c d x (2)')
    expect(sheetName('x'.repeat(40), taken)).toHaveLength(31)
  })
  it('names the file', () => {
    expect(exportFileName('Smith: House', new Date(2026, 2, 5))).toBe('Smith- House - Device Schedule - 2026-03-05.xlsx')
  })
})
