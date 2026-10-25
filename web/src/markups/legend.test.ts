import { describe, expect, it } from 'vitest'
import { buildCatalog } from '../catalog/catalog'
import { DEFAULT_LEGEND, legendFields, legendItems, legendLayout, legendRows, legendSettings, moveManual, scopeOf, sortLegendRows } from './legend'
import { fieldsFromPreset, presetPayload, settingsFromPreset } from '../legend/presets'
import { DEFAULT_STYLE } from './types'
import type { Markup, SymbolSet } from './types'

const sets = new Map<string, SymbolSet>([
  ['s1', { id: 's1', name: 'Fire', color: '#f00', tag_prefix: 'FA', icon: 'data:image/png;base64,AA', fields: [], has_fov: false, sort: 0 }],
])
const catalog = buildCatalog({
  device_types: [
    { id: 't1', symbol_set_id: 's1', name: 'Smoke', icon: 'data:image/png;base64,BB', tag_prefix: 'SD', fields: [], default_product_id: null, sort: 0 },
    { id: 't2', symbol_set_id: 's1', name: 'Horn', icon: '', tag_prefix: 'HN', fields: [], default_product_id: null, sort: 1 },
  ],
  products: [
    { id: 'p1', device_type_id: 't1', kind: 'device', manufacturer: 'Acme', model: 'SD100', name: '', spec_url: '', unit_cost: 0, labor_hours: 0, default_fields: {}, accessories: [], active: true },
    { id: 'p2', device_type_id: 't1', kind: 'device', manufacturer: 'Acme', model: 'SD200', name: '', spec_url: '', unit_cost: 0, labor_hours: 0, default_fields: {}, accessories: [], active: true },
  ],
})
let n = 0
const dev = (page: number, x: number, y: number, extra: Partial<Markup> = {}): Markup => ({
  id: `d${++n}`, document_id: 'doc', page, type: 'device', geometry: { x, y, width: 20, height: 20, rotation: 0 },
  style: DEFAULT_STYLE, text: '', layer_id: null, symbol_set_id: 's1', device_type_id: 't1', product_id: null, tag: '', ...extra,
})
const area = (id: string, page: number, x0: number, y0: number, x1: number, y1: number, extra: Partial<Markup> = {}): Markup => ({
  id, document_id: 'doc', page, type: 'area', geometry: { x: 0, y: 0, rotation: 0, points: [x0, y0, x1, y0, x1, y1, x0, y1] },
  style: DEFAULT_STYLE, text: id, layer_id: null, ...extra,
})

const markups = [
  dev(1, 10, 10, { product_id: 'p1' }), dev(1, 10, 10, { product_id: 'p1' }), // a stack of two on one spot
  dev(1, 100, 100, { product_id: 'p2' }),
  dev(1, 300, 300, { device_type_id: 't2' }),
  dev(2, 10, 10, { product_id: 'p1' }),
  dev(2, 10, 10, { device_type_id: null }),
  { ...dev(1, 5, 5), type: 'rect' as const },
]

describe('legendRows', () => {
  it('counts every device of the sheet, stack members included, by type', () => {
    const rows = legendRows(markups, catalog, { kind: 'sheet', page: 1 }, { symbolSets: sets })
    expect(rows.map(r => [r.name, r.count])).toEqual([['Horn', 1], ['Smoke', 3]])
    expect(rows.find(r => r.name === 'Smoke')).toMatchObject({ icon: 'data:image/png;base64,BB', color: '#f00' })
    // Horn has no icon of its own: the set's
    expect(rows.find(r => r.name === 'Horn')!.icon).toBe('data:image/png;base64,AA')
  })
  it('covers the whole document and falls back to the set for untyped devices', () => {
    const rows = legendRows(markups, catalog, { kind: 'document' }, { symbolSets: sets })
    expect(rows.map(r => [r.name, r.count])).toEqual([['Fire', 1], ['Horn', 1], ['Smoke', 4]])
  })
  it('groups by product and by type + product', () => {
    const byProduct = legendRows(markups, catalog, { kind: 'sheet', page: 1 }, { groupBy: 'product', symbolSets: sets })
    expect(byProduct.map(r => [r.name, r.code, r.count])).toEqual([['Acme SD100', 'SD100', 2], ['Acme SD200', 'SD200', 1], ['Horn', '', 1]])
    const both = legendRows(markups, catalog, { kind: 'sheet', page: 1 }, { groupBy: 'type+product', symbolSets: sets })
    expect(both.map(r => [r.name, r.count])).toEqual([['Horn', 1], ['Smoke - Acme SD100', 2], ['Smoke - Acme SD200', 1]])
  })
  it('limits to an area, nested areas included', () => {
    const list = [...markups, area('A', 1, 0, 0, 50, 50), area('B', 1, 0, 0, 20, 20), area('C', 1, 90, 90, 150, 150)]
    expect(legendRows(list, catalog, { kind: 'area', areaId: 'A' }, { symbolSets: sets }).map(r => [r.name, r.count])).toEqual([['Smoke', 2]])
    expect(legendRows(list, catalog, { kind: 'area', areaId: 'C' }, { symbolSets: sets }).map(r => [r.name, r.count])).toEqual([['Smoke', 1]])
  })
  it('is empty without devices', () => {
    expect(legendRows([], catalog, { kind: 'document' })).toEqual([])
  })
})

describe('legend settings', () => {
  it('round-trips through fields and tolerates garbage', () => {
    const s = { ...DEFAULT_LEGEND, scope: 'area:x', groupBy: 'product' as const, columns: ['name' as const, 'count' as const], title: 'Devices' }
    expect(legendSettings({ fields: legendFields(s) })).toEqual(s)
    expect(legendSettings({})).toEqual(DEFAULT_LEGEND)
    expect(legendSettings({ fields: { columns: 'bogus', groupBy: 'nope' } })).toEqual({ ...DEFAULT_LEGEND, title: 'Legend' })
    expect(scopeOf('document', 3)).toEqual({ kind: 'document' })
    expect(scopeOf('area:q', 3)).toEqual({ kind: 'area', areaId: 'q' })
    expect(scopeOf('sheet', 3)).toEqual({ kind: 'sheet', page: 3 })
  })
  it('lays out an auto height from the row count', () => {
    const one = legendLayout([], DEFAULT_LEGEND, 200, 12)
    const five = legendLayout(new Array(5).fill(0).map((_, i) => ({ key: String(i), name: 'x', code: '', manufacturer: '', model: '', description: '', setId: 's1', setName: 'Fire', setSort: 0, icon: '', color: '', count: 1 })), DEFAULT_LEGEND, 200, 12)
    expect(five.height - one.height).toBeCloseTo(4 * five.rowH)
    expect(five.widths.name).toBeGreaterThan(20)
  })
})

describe('legend sorting, columns and filters', () => {
  const rows = legendRows(markups, catalog, { kind: 'document' }, { symbolSets: sets, groupBy: 'type+product' })
  it('sorts by name, code, count and manual order', () => {
    const names = (sort: Parameters<typeof sortLegendRows>[1]['sort'], manual: string[] = []) => sortLegendRows(rows, { sort, manual }).map(r => r.name)
    expect(names('name')).toEqual(['Fire', 'Horn', 'Smoke - Acme SD100', 'Smoke - Acme SD200'])
    expect(names('count-desc')[0]).toBe('Smoke - Acme SD100')
    expect(names('count-asc').at(-1)).toBe('Smoke - Acme SD100')
    expect(names('code').slice(0, 2)).toEqual(['Smoke - Acme SD100', 'Smoke - Acme SD200']) // rows with a code first
    const keys = rows.map(r => r.key)
    expect(sortLegendRows(rows, { sort: 'manual', manual: [keys[3], keys[0]] }).map(r => r.key).slice(0, 2)).toEqual([keys[3], keys[0]])
  })
  it('moves rows and columns one step', () => {
    expect(moveManual(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
    expect(moveManual(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
  })
  it('adds a sub-header per symbol set when grouped', () => {
    const items = legendItems(rows, { sort: 'name', manual: [], groupBySet: true })
    expect(items[0]).toMatchObject({ kind: 'header', label: 'Fire' })
    expect(items.filter(i => i.kind === 'header')).toHaveLength(1)
    expect(legendLayout(rows, { ...DEFAULT_LEGEND, groupBySet: true }, 300, 12).height).toBeGreaterThan(legendLayout(rows, DEFAULT_LEGEND, 300, 12).height)
  })
  it('lists zero-count types and limits to chosen sets', () => {
    const none = legendRows([], catalog, { kind: 'document' }, { symbolSets: sets, showZero: true })
    expect(none.map(r => [r.name, r.count])).toEqual([['Horn', 0], ['Smoke', 0]])
    expect(legendRows(markups, catalog, { kind: 'document' }, { symbolSets: sets, setIds: ['other'] })).toEqual([])
    expect(legendRows(markups, catalog, { kind: 'document' }, { symbolSets: sets, setIds: ['s1'] }).length).toBeGreaterThan(0)
  })
  it('fills manufacturer, model and description from the product', () => {
    const r = legendRows(markups, catalog, { kind: 'sheet', page: 1 }, { symbolSets: sets, groupBy: 'product' }).find(x => x.code === 'SD100')!
    expect(r).toMatchObject({ manufacturer: 'Acme', model: 'SD100', setName: 'Fire' })
  })
  it('round-trips the new settings and tolerates bad columns/widths', () => {
    const s = { ...DEFAULT_LEGEND, columns: ['icon' as const, 'manufacturer' as const, 'model' as const, 'count' as const], sort: 'count-desc' as const, manual: ['a', 'b'], groupBySet: true, showZero: true, setIds: ['s1'], widths: { model: 2 }, aligns: { count: 'center' as const } }
    expect(legendSettings({ fields: legendFields(s) })).toEqual(s)
    expect(legendSettings({ fields: { widths: 'name:-1,bogus:2,model:x', aligns: 'name:diagonal', sort: 'nope' } })).toMatchObject({ widths: {}, aligns: {}, sort: 'name' })
    const L = legendLayout([], { ...DEFAULT_LEGEND, columns: ['name', 'model'], widths: { name: 1, model: 3 } }, 200, 12)
    expect(L.widths.model).toBeCloseTo(L.widths.name * 3)
  })
})

describe('legend presets', () => {
  it('round-trips settings and attaches a set', () => {
    const s = { ...DEFAULT_LEGEND, scope: 'area:zz', sort: 'set' as const, columns: ['name' as const, 'description' as const, 'count' as const], groupBySet: true }
    const payload = presetPayload('  Fire legend ', s, 's1')
    expect(payload).toMatchObject({ name: 'Fire legend', set_id: 's1' })
    expect(payload.settings.scope).toBe('sheet') // an area id means nothing in another document
    const back = settingsFromPreset(payload)
    expect(back).toMatchObject({ sort: 'set', groupBySet: true, columns: ['name', 'description', 'count'], setIds: ['s1'] })
    expect(legendSettings({ fields: fieldsFromPreset(payload) })).toEqual(back)
    expect(settingsFromPreset({ settings: payload.settings, set_id: null }).setIds).toEqual([])
  })
})
