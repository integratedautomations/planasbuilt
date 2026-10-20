import { describe, expect, it } from 'vitest'
import { buildCatalog } from '../catalog/catalog'
import { data, sets } from '../catalog/fixtures'
import { isSameDevice, replaceDevice } from './replaceDevice'
import { selectAfterDelete, pushSelection } from './selectionHistory'
import { DEFAULT_STYLE } from './types'
import type { Markup } from './types'

const cat = buildCatalog({
  device_types: [...data.device_types,
    { id: 'ht', symbol_set_id: 'fa', name: 'Heat Detector', icon: '', tag_prefix: 'HD', fields: [{ key: 'zone', label: 'Zone', type: 'text' }], default_product_id: null, sort: 1 },
    { id: 'sd2', symbol_set_id: 'fa', name: 'Smoke 2', icon: '', tag_prefix: 'SD', fields: [], default_product_id: null, sort: 2 }],
  products: data.products,
})
const symbolSets = new Map(sets.map(s => [s.id, s]))
const smoke: Markup = {
  id: 'm1', document_id: 'd', page: 1, type: 'device', text: 'note', layer_id: 'L', style: DEFAULT_STYLE, symbol_set_id: 'fa', device_type_id: 'sd',
  product_id: 'pad', tag: 'SD-03', status: 'installed', geometry: { x: 10, y: 20, width: 24, height: 24, rotation: 45 },
  fields: { zone: 'Z1', serial: 'S9', manufacturer: 'Potter', model: 'PAD100', device_type: 'Smoke', gone: 'x' },
}

describe('replaceDevice', () => {
  it('keeps geometry, status, notes and matching fields; retags when the prefix changes', () => {
    const r = replaceDevice(smoke, { setId: 'fa', typeId: 'ht' }, symbolSets, cat)
    expect(r.geometry).toEqual(smoke.geometry)
    expect(r).toMatchObject({ id: 'm1', device_type_id: 'ht', product_id: null, tag: '', status: 'installed', text: 'note', layer_id: 'L' })
    expect(r.fields).toMatchObject({ zone: 'Z1', serial: 'S9' })
    expect(r.fields).not.toHaveProperty('gone')
    expect(r.fields).not.toHaveProperty('device_type')
  })
  it('keeps the tag when the prefix is unchanged, and follows the new product', () => {
    const r = replaceDevice(smoke, { setId: 'fa', typeId: 'sd2', productId: null }, symbolSets, cat)
    expect(r.tag).toBe('SD-03')
    expect(r.fields).not.toHaveProperty('zone')
    const p = replaceDevice(smoke, { setId: 'fa', typeId: 'sd' }, symbolSets, cat)
    expect(p.product_id).toBe('pad')
    expect(p.fields).toMatchObject({ manufacturer: 'Potter', model: 'PAD100' })
  })
  it('switching set drops set fields, clears the tag and adds a camera cone', () => {
    const r = replaceDevice(smoke, { setId: 'cam', typeId: 'ipc' }, symbolSets, cat)
    expect(r).toMatchObject({ symbol_set_id: 'cam', tag: '', product_id: 'cam1' })
    expect((r.geometry as { fov?: unknown }).fov).toBeDefined()
    expect(r.fields).not.toHaveProperty('zone')
    expect(r.fields).toMatchObject({ serial: 'S9', manufacturer: 'Axis', model: 'M3216' })
    const back = replaceDevice(r, { setId: 'fa', typeId: 'sd' }, symbolSets, cat)
    expect((back.geometry as { fov?: unknown }).fov).toBeUndefined()
  })
  it('detects a no-op', () => {
    expect(isSameDevice(smoke, { setId: 'fa', typeId: 'sd' })).toBe(true)
    expect(isSameDevice(smoke, { setId: 'fa', typeId: 'ht' })).toBe(false)
    expect(isSameDevice(smoke, { setId: 'fa', typeId: 'sd', productId: null })).toBe(false)
  })
})

const at = (id: string, x: number, page = 1, extra: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd', page, type: 'rect', text: '', layer_id: null, style: DEFAULT_STYLE, geometry: { x, y: 0, width: 10, height: 10, rotation: 0 }, ...extra,
})

describe('selection history and delete', () => {
  it('records selections without empties or repeats', () => {
    let h: string[][] = []
    h = pushSelection(h, ['a']); h = pushSelection(h, ['a']); h = pushSelection(h, []); h = pushSelection(h, ['b', 'c'])
    expect(h).toEqual([['a'], ['b', 'c']])
  })
  it('selects what was selected before the deleted markup', () => {
    const all = [at('a', 0), at('b', 50), at('c', 100)]
    expect(selectAfterDelete({ history: [['a'], ['c'], ['b']], deleted: [all[1]], remaining: all })).toEqual(['c'])
  })
  it('skips history entries that are gone or on another page, then falls back to the nearest on the page', () => {
    const all = [at('a', 0), at('b', 50), at('far', 400), at('near', 60), at('other', 52, 2)]
    expect(selectAfterDelete({ history: [['other'], ['zzz'], ['b']], deleted: [all[1]], remaining: all })).toEqual(['near'])
    expect(selectAfterDelete({ history: [], deleted: [at('x', 0)], remaining: [at('x', 0)] })).toEqual([])
  })
  it('handles deleting several at once', () => {
    const all = [at('a', 0), at('b', 50), at('c', 100)]
    expect(selectAfterDelete({ history: [['a'], ['b', 'c']], deleted: [all[1], all[2]], remaining: all })).toEqual(['a'])
  })
})
