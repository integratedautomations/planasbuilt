import { describe, expect, it } from 'vitest'
import { buildCatalog } from './catalog/catalog'
import { can, CAPS, isFieldOnly, ROLE_INFO, ROLES } from './roles'

describe('web capability map', () => {
  it('describes every role', () => {
    for (const r of ROLES) expect(ROLE_INFO[r].label).toBeTruthy()
  })
  it('admin has every capability; only admin manages members', () => {
    for (const c of CAPS) expect(can('admin', c)).toBe(true)
    for (const r of ROLES.filter(r => r !== 'admin')) expect(can(r, 'members.manage')).toBe(false)
  })
  it('pm = editor + costs', () => {
    expect(can('pm', 'costs.view', { editorsSeeCosts: false })).toBe(true)
    expect(can('pm', 'markup.geometry')).toBe(true)
    expect(can('pm', 'members.manage')).toBe(false)
  })
  it('editors see costs only while the project setting is on', () => {
    expect(can('editor', 'costs.view')).toBe(true)
    expect(can('editor', 'costs.view', { editorsSeeCosts: false })).toBe(false)
  })
  it('field and sub edit fields only', () => {
    for (const r of ['field', 'sub'] as const) {
      expect(isFieldOnly(r)).toBe(true)
      expect(can(r, 'markup.fields')).toBe(true)
      expect(can(r, 'markup.create')).toBe(false)
      expect(can(r, 'markup.geometry')).toBe(false)
      expect(can(r, 'markup.delete')).toBe(false)
      expect(can(r, 'plans.edit')).toBe(false)
      expect(can(r, 'costs.view')).toBe(false)
    }
    expect(isFieldOnly('editor')).toBe(false)
    expect(isFieldOnly('viewer')).toBe(false)
  })
  it('client is read-only with no costs or internal fields', () => {
    expect(can('client', 'view')).toBe(true)
    expect(can('client', 'markup.fields')).toBe(false)
    expect(can('client', 'costs.view')).toBe(false)
    expect(can('client', 'internal.view')).toBe(false)
    expect(can('viewer', 'costs.view')).toBe(true)
  })
  it('matches the server table', async () => {
    // The two files are plain data; this guards against one drifting from the other.
    const server = await import('../../server/src/roles')
    expect([...ROLES]).toEqual([...server.ROLES])
    expect([...CAPS]).toEqual([...server.CAPS])
    for (const r of ROLES) for (const c of CAPS) for (const e of [true, false])
      expect(can(r, c, { editorsSeeCosts: e }), `${r} ${c}`).toBe(server.can(r, c, { editorsSeeCosts: e }))
  })
})

describe('catalog without costs', () => {
  const product = { id: 'p', device_type_id: 't', kind: 'device', manufacturer: 'M', model: 'X', name: '', spec_url: '', default_fields: {}, accessories: [{ name: 'a', qty: 1 }], active: true }
  it('keeps the BOM maths finite when the server withheld costs', () => {
    const cat = buildCatalog({ device_types: [], products: [product as any], can_see_costs: false })
    expect(cat.canSeeCosts).toBe(false)
    expect(cat.products.get('p')).toMatchObject({ unit_cost: 0, labor_hours: 0 })
    expect(buildCatalog({ device_types: [], products: [] }).canSeeCosts).toBe(true)
  })
})
