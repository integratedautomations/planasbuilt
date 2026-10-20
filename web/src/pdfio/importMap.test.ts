import { describe, expect, it } from 'vitest'
import { hasDrawableGeometry } from '../markups/geometry'
import { DEFAULT_STYLE } from '../markups/types'
import { parsePayload, sanitizeMarkup } from './importMap'

const known = { layers: new Set(['L1']), symbolSets: new Set(['S1']), deviceTypes: new Set(['T1']), products: new Set(['P1']) }
const good = { id: 'm1', document_id: 'd', page: 2, type: 'rect', geometry: { x: 1, y: 2, width: 3, height: 4, rotation: 0 }, style: DEFAULT_STYLE, text: 'hi', layer_id: 'L1' }

describe('sanitizeMarkup', () => {
  it('keeps a good markup and known ids', () => {
    const m = sanitizeMarkup({ ...good, symbol_set_id: 'S1', device_type_id: 'T1', product_id: 'P1', status: 'tested', fields: { a: 'x', b: 2, c: true } }, known)!
    expect(m).toMatchObject({ id: 'm1', layer_id: 'L1', symbol_set_id: 'S1', device_type_id: 'T1', product_id: 'P1', status: 'tested', fields: { a: 'x', b: 2, c: true } })
  })
  it('drops unknown ids', () => {
    const m = sanitizeMarkup({ ...good, layer_id: 'X', symbol_set_id: 'X', device_type_id: 'X', product_id: 'X' }, known)!
    expect([m.layer_id, m.symbol_set_id, m.device_type_id, m.product_id]).toEqual([null, null, null, null])
  })
  it('rejects bad types and geometry', () => {
    expect(sanitizeMarkup({ ...good, type: 'evil' })).toBeNull()
    expect(sanitizeMarkup({ ...good, type: '__proto__' })).toBeNull()
    expect(sanitizeMarkup({ ...good, geometry: { x: 1, y: 2, width: NaN, height: 4 } })).toBeNull()
    expect(sanitizeMarkup({ ...good, geometry: { x: 1, y: 2, width: 1e12, height: 4 } })).toBeNull()
    expect(sanitizeMarkup({ ...good, type: 'line', geometry: { x: 0, y: 0, rotation: 0, points: [1, 2, 3] } })).toBeNull()
    expect(sanitizeMarkup({ ...good, type: 'line', geometry: { x: 0, y: 0, rotation: 0, points: [1, 2, 'a', 4] } })).toBeNull()
    expect(sanitizeMarkup({ ...good, type: 'line', geometry: { x: 0, y: 0, rotation: 0, points: 'xx' } })).toBeNull()
    expect(sanitizeMarkup({ ...good, id: '<script>' })).toBeNull()
    expect(sanitizeMarkup(null)).toBeNull()
    expect(sanitizeMarkup([])).toBeNull()
  })
  it('normalizes style, text, status, fields, fov', () => {
    const m = sanitizeMarkup({
      ...good, text: 'a'.repeat(50_000), status: 'hacked',
      style: { stroke: 'url(javascript:1)', fill: '#abc', strokeWidth: 1e9, opacity: 'x', fontSize: -5, evil: 1 },
      fields: { s: 'ok', o: { nested: 1 }, n: Infinity, arr: [1], ['__proto__']: 'x' },
      geometry: { ...good.geometry, fov: { direction: 1, angle: 'x', range: 5 } },
    })!
    expect(m.text.length).toBe(10_000)
    expect(m.status).toBeUndefined()
    expect(m.style).toEqual({ ...DEFAULT_STYLE, fill: '#abc', strokeWidth: 200, fontSize: 1 })
    expect(m.fields).toEqual({ s: 'ok' })
    expect((m.geometry as any).fov).toBeUndefined()
    const ok = sanitizeMarkup({ ...good, geometry: { ...good.geometry, fov: { direction: 1, angle: 90, range: 5, hidden: true } } })!
    expect((ok.geometry as any).fov).toEqual({ direction: 1, angle: 90, range: 5, hidden: true })
  })
  it('caps the number of fields', () => {
    const fields = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(sanitizeMarkup({ ...good, fields })!.fields!)).toHaveLength(64)
  })
})

describe('parsePayload', () => {
  it('handles garbage', () => {
    expect(parsePayload('not json')).toBeNull()
    expect(parsePayload('{"type":"rect","geometry":{"x":"1","y":2}}')).toBeNull()
    expect(parsePayload(undefined)).toBeNull()
    expect(parsePayload(JSON.stringify(good))).not.toBeNull()
  })
})

describe('hasDrawableGeometry', () => {
  it('flags bad geometry', () => {
    expect(hasDrawableGeometry(good)).toBe(true)
    expect(hasDrawableGeometry({ geometry: { x: 0, y: 0, points: [1, NaN] } })).toBe(false)
    expect(hasDrawableGeometry({ geometry: { x: 0, y: 0, width: 1 } })).toBe(false)
    expect(hasDrawableGeometry({ geometry: null })).toBe(false)
  })
})
