import { describe, expect, it } from 'vitest'
import { buildCatalog, defaultProductId, deviceIcon, fieldDefsFor, productFields, productsFor, refillFields, tagPrefixFor } from './catalog'
import { data, sets } from './fixtures'

const cat = buildCatalog(data)

describe('catalog helpers', () => {
  it('lists active device products and picks the default', () => {
    expect(productsFor(cat, 'ipc').map(p => p.id)).toEqual(['cam1'])
    expect(defaultProductId(cat, 'sd')).toBe('pad')
    expect(defaultProductId(cat, 'ipc')).toBe('cam1') // no default set: first active
    expect(defaultProductId(cat, undefined)).toBeNull()
  })
  it('uses the type icon, falling back to the set icon', () => {
    expect(deviceIcon({ device_type_id: 'sd' }, sets[0], cat)).toBe('sd.png')
    expect(deviceIcon({ device_type_id: 'ipc' }, sets[1], cat)).toBe('cam.png')
    expect(deviceIcon({}, sets[1], cat)).toBe('cam.png')
  })
  it('adds type fields after set fields and prefers the type prefix', () => {
    expect(fieldDefsFor(sets[0], cat.types.get('sd')).map(f => f.key)).toEqual(['zone'])
    expect(fieldDefsFor(sets[1], cat.types.get('ipc')).map(f => f.key)).toEqual(['ip'])
    expect(tagPrefixFor(sets[0], cat.types.get('sd'))).toBe('SD')
    expect(tagPrefixFor(sets[1], cat.types.get('ipc'))).toBe('CAM')
  })
  it('prefills a new device from the product', () => {
    expect(productFields(cat.products.get('pad'))).toEqual({ device_type: 'Smoke', manufacturer: 'Potter', model: 'PAD100' })
    expect(productFields(undefined)).toEqual({})
  })
  it('switching product refills manufacturer and model but keeps other values', () => {
    const out = refillFields({ manufacturer: 'Axis', model: 'M3216', serial: 'S1', zone: '4', device_type: 'Heat' }, cat.products.get('pad'))
    expect(out).toMatchObject({ manufacturer: 'Potter', model: 'PAD100', serial: 'S1', zone: '4', device_type: 'Heat' })
    expect(refillFields({ serial: 'S1' }, cat.products.get('pad'))).toMatchObject({ serial: 'S1', device_type: 'Smoke' })
  })
})
