import { describe, expect, it } from 'vitest'
import { accessoriesText, catalogTable, parseAccessories, parseCatalogSheets, planCatalogImport, resolveAccessories } from './catalogIO'
import { data, sets } from './fixtures'

const header = ['Set', 'Type', 'Manufacturer', 'Model', 'Name', 'Unit cost', 'Labor hours', 'Accessories', 'Default fields', 'Lens']

describe('catalog excel', () => {
  it('exports a Products sheet with set/type, accessories text and default fields', () => {
    const t = catalogTable(data, sets)
    expect(t.name).toBe('Products')
    expect(t.header.slice(0, 4)).toEqual(['Set', 'Type', 'Manufacturer', 'Model'])
    const pad = t.data.find(r => r[3] === 'PAD100')!
    expect(pad.slice(0, 2)).toEqual(['Fire Alarm', 'Smoke Detector'])
    expect(pad[8]).toBe('B6 x 1; Label x 2')
    expect(pad[9]).toBe('{"device_type":"Smoke"}')
    expect(t.data.at(-1)![3]).toBe('B6') // standalone accessories last, empty set
    expect(accessoriesText(data.products[0], new Map(data.products.map(p => [p.id, p])))).toBe('B6 x 1; Label x 2')
  })
  it('parses accessories text', () => {
    expect(parseAccessories('B6 x 2; Rack kit; Foo × 3')).toEqual([{ ref: 'B6', qty: 2 }, { ref: 'Rack kit', qty: 1 }, { ref: 'Foo', qty: 3 }])
  })
  it('reads rows, extra columns become default fields, and flags bad rows', () => {
    const rows = parseCatalogSheets([{ name: 'Products', rows: [header,
      ['Cameras', 'IP Camera', 'Axis', 'P3265', 'Dome', '$610.50', 1.5, 'B6 x 2', '{"a":1}', 'Fixed dome'],
      ['Cameras', 'IP Camera', 'Axis', 'X', 'Bad', 'abc', null, null, '{nope', null],
      [null, null, null, null, null, null, null, null, null, null]] }])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ row: 2, unit_cost: 610.5, labor_hours: 1.5, accessories: [{ ref: 'B6', qty: 2 }], default_fields: { a: 1, lens: 'Fixed dome' } })
    expect(rows[1].problems).toHaveLength(2)
  })
  it('plans create/update/unchanged/error by manufacturer + model', () => {
    const rows = parseCatalogSheets([{ name: 'Products', rows: [header,
      ['Fire Alarm', 'Smoke Detector', 'potter', 'pad100', 'Photo smoke', 65, 0.5, 'B6 x 1; Label x 2', null, null],
      ['Fire Alarm', 'Smoke Detector', 'Potter', 'NEW', 'New one', 10, 0.1, null, null, null],
      ['Fire Alarm', 'Duct Detector', 'Potter', 'DUCT', 'Duct', 99, 1, null, null, null],
      ['Fire Alarm', 'Smoke Detector', 'Axis', 'M3216', 'Dome', 500, 1.5, null, null, null],
      ['Nope', 'X', 'A', 'B', null, 1, 1, null, null, null],
      ['', '', 'Potter', 'B6', 'Base', 8, 0.25, null, null, null]] }])
    const plan = planCatalogImport(rows, data, sets)
    expect(plan.items.map(i => i.action)).toEqual(['update', 'create', 'create', 'error', 'error', 'unchanged'])
    expect(plan.items[0].changes).toEqual([{ field: 'Unit cost', from: '60', to: '65' }])
    expect(plan.items[2].newType).toBe(true)
    expect(plan.newTypes).toBe(1)
    expect(plan.items[3].errors[0]).toMatch(/another device type/)
    expect(plan.items[4].errors[0]).toMatch(/Unknown set/)
  })
  it('resolves accessory refs to products, else one-off items', () => {
    expect(resolveAccessories([{ ref: 'b6', qty: 2 }, { ref: 'Rack kit', qty: 1 }], data.products)).toEqual([{ product_id: 'base', qty: 2 }, { name: 'Rack kit', qty: 1 }])
  })
})
