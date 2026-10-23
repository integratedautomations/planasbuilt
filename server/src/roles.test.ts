import { describe, expect, it } from 'vitest'
import { can, canSeeMarkup, CAPS, filterMarkups, inScope, normalizeScope, ROLES, stripInternalValues, stripProductCosts } from './roles.js'

describe('capability map', () => {
  it('admin can do everything', () => {
    for (const c of CAPS) expect(can('admin', c)).toBe(true)
  })

  it('only admins manage members or delete plans', () => {
    for (const r of ROLES.filter(r => r !== 'admin')) {
      expect(can(r, 'members.manage')).toBe(false)
      expect(can(r, 'plans.delete')).toBe(false)
    }
  })

  it('pm is an editor plus costs, without member management', () => {
    for (const c of CAPS.filter(c => c !== 'members.manage' && c !== 'plans.delete')) expect(can('pm', c)).toBe(true)
    expect(can('pm', 'costs.view', { editorsSeeCosts: false })).toBe(true)
  })

  it('editors see costs only while the project setting is on (default on)', () => {
    expect(can('editor', 'costs.view')).toBe(true)
    expect(can('editor', 'costs.view', { editorsSeeCosts: true })).toBe(true)
    expect(can('editor', 'costs.view', { editorsSeeCosts: false })).toBe(false)
    expect(can('editor', 'markup.geometry')).toBe(true)
  })

  it('field and sub edit fields and photos but never geometry, creation, deletion or plans', () => {
    for (const r of ['field', 'sub'] as const) {
      expect(can(r, 'markup.fields')).toBe(true)
      expect(can(r, 'photos.edit')).toBe(true)
      expect(can(r, 'comment')).toBe(true)
      for (const c of ['markup.create', 'markup.geometry', 'markup.delete', 'plans.edit', 'costs.view'] as const) expect(can(r, c)).toBe(false)
    }
  })

  it('client is read-only without costs or internal fields; viewer is as before', () => {
    for (const c of CAPS) if (c !== 'view' && c !== 'comment') expect(can('client', c)).toBe(false)
    expect(can('client', 'view')).toBe(true)
    expect(can('viewer', 'view')).toBe(true)
    expect(can('viewer', 'markup.fields')).toBe(false)
    expect(can('viewer', 'costs.view')).toBe(true)
    expect(can('viewer', 'internal.view')).toBe(true)
  })

  it('a missing role can do nothing', () => {
    expect(can(null, 'view')).toBe(false)
    expect(can(undefined, 'view')).toBe(false)
  })
})

describe('scope', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  it('normalizes junk to an empty scope', () => {
    expect(normalizeScope(null)).toEqual({ sets: [], layers: [] })
    expect(normalizeScope({ sets: ['nope', 5, A, A.toUpperCase()], layers: 'x' })).toEqual({ sets: [A], layers: [] })
  })
  it('matches a markup by symbol set or layer; empty scope matches nothing', () => {
    const scope = { sets: [A], layers: [B] }
    expect(inScope(scope, { symbol_set_id: A })).toBe(true)
    expect(inScope(scope, { layer_id: B })).toBe(true)
    expect(inScope(scope, { symbol_set_id: B, layer_id: A })).toBe(false)
    expect(inScope(scope, {})).toBe(false)
    expect(inScope({ sets: [], layers: [] }, { symbol_set_id: A })).toBe(false)
  })
  it('only restricts subs', () => {
    const scope = { sets: [], layers: [] }
    expect(canSeeMarkup({ role: 'field', scope }, { symbol_set_id: A })).toBe(true)
    expect(canSeeMarkup({ role: 'sub', scope }, { symbol_set_id: A })).toBe(false)
    expect(filterMarkups({ role: 'sub', scope: { sets: [A], layers: [] } }, [{ symbol_set_id: A }, { symbol_set_id: B }])).toEqual([{ symbol_set_id: A }])
  })
})

describe('stripping', () => {
  it('removes cost and labor, accessories included', () => {
    const p = stripProductCosts({ id: 1, model: 'x', unit_cost: 5, labor_hours: 1, accessories: [{ name: 'a', unit_cost: 2, labor_hours: 1, qty: 1 }, { product_id: 'p', qty: 2 }] })
    expect(p).toEqual({ id: 1, model: 'x', accessories: [{ name: 'a', qty: 1 }, { product_id: 'p', qty: 2 }] })
  })
  it('removes internal field values', () => {
    expect(stripInternalValues({ fields: { ip: '1', pw: 'x' } }, new Set(['pw']))).toEqual({ fields: { ip: '1' } })
  })
})
