import { describe, expect, it } from 'vitest'
import { coerceField, mapHeaders, parseStatus, planImport } from './importDiff'
import type { Markup, SymbolSet } from '../markups/types'

const style = { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }
const dev = (id: string, tag: string, extra: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd', page: 1, type: 'device', symbol_set_id: 'cam', tag, status: 'planned', fields: {},
  geometry: { x: 0, y: 0, width: 20, height: 20, rotation: 0 }, style, text: '', layer_id: null, ...extra,
})
const sets: SymbolSet[] = [{ id: 'cam', name: 'Cameras', color: '', tag_prefix: 'CAM', icon: '', has_fov: true, sort: 1,
  fields: [{ key: 'ip', label: 'IP', type: 'ip' }, { key: 'poe', label: 'PoE', type: 'checkbox' }, { key: 'lens', label: 'Lens', type: 'select', options: ['2.8mm', '4mm'] }] }]
const devices = [dev('a', 'CAM-1', { fields: { manufacturer: 'Axis', ip: '1.1.1.1' } }), dev('b', 'CAM-2')]
const off = { clearBlanks: false }

describe('mapHeaders', () => {
  it('maps by header text, case-insensitively', () => {
    const m = mapHeaders(['id', 'TAG', 'status', 'Model #', 'ip', 'Area 1', 'Mystery', 'notes'], sets)
    expect(m.map(c => c.target.kind)).toEqual(['id', 'tag', 'status', 'field', 'field', 'ignored', 'unknown', 'field'])
  })
})

describe('parseStatus / coerceField', () => {
  it('accepts labels and values', () => {
    expect(parseStatus('Installed')).toBe('installed')
    expect(parseStatus(' PUNCH ')).toBe('punch')
    expect(parseStatus('')).toBe('')
    expect(parseStatus('nonsense')).toBeNull()
  })
  it('coerces by type', () => {
    expect(coerceField('Yes', sets[0].fields[1])).toBe(true)
    expect(coerceField('4MM', sets[0].fields[2])).toBe('4mm')
    expect(coerceField('9mm', sets[0].fields[2])).toBeUndefined()
    expect(coerceField('12', { key: 'z', label: 'Z', type: 'number' })).toBe(12)
    expect(coerceField(new Date(2026, 0, 5), { key: 'd', label: 'D', type: 'date' })).toBe('2026-01-05')
  })
})

describe('planImport', () => {
  const head = ['id', 'Tag', 'Status', 'IP', 'Manufacturer', 'Notes']
  it('matches by id first, then tag, and diffs only changes', () => {
    const plan = planImport([{ name: 'S', rows: [head,
      ['a', 'WRONG', 'Installed', '1.1.1.1', 'Axis', 'hi'],
      ['', 'cam-2', '', '2.2.2.2', '', ''],
      ['zzz', 'CAM-99', '', '', '', ''],
    ] }], devices, sets, off)
    expect(plan.matched).toBe(2)
    expect(plan.unmatched).toHaveLength(1)
    expect(plan.unmatched[0]).toMatchObject({ row: 4, label: 'CAM-99' })
    const a = plan.changed.find(c => c.markup.id === 'a')!
    expect(a.changes.map(c => c.key)).toEqual(['status', 'notes'])
    expect(a.after.status).toBe('installed')
    expect(a.changes[0]).toMatchObject({ old: 'Planned', next: 'Installed' })
    const b = plan.changed.find(c => c.markup.id === 'b')!
    expect(b.changes.map(c => c.key)).toEqual(['ip'])
    expect(b.after.fields).toEqual({ ip: '2.2.2.2' })
  })
  it('blank cells keep values unless clearBlanks', () => {
    const rows = [head, ['a', '', '', '', '', '']]
    expect(planImport([{ name: 'S', rows }], devices, sets, off).changed).toHaveLength(0)
    const plan = planImport([{ name: 'S', rows }], devices, sets, { clearBlanks: true })
    expect(plan.changed[0].changes.map(c => [c.key, c.next])).toEqual([['status', ''], ['ip', ''], ['manufacturer', '']])
  })
  it('handles each device once across sheets and skips sheets with no id/tag', () => {
    const plan = planImport([
      { name: 'All', rows: [head, ['a', 'CAM-1', '', '', '', 'x']] },
      { name: 'Cameras', rows: [head, ['a', 'CAM-1', '', '', '', 'y']] },
      { name: 'Measurements', rows: [['Type', 'Value'], ['measure-length', '5']] },
    ], devices, sets, off)
    expect(plan.sheetsUsed).toEqual(['All', 'Cameras'])
    expect(plan.matched).toBe(1)
    expect(plan.changed[0].after.fields?.notes).toBe('x')
  })
  it('warns on bad values and refuses ambiguous tags', () => {
    const dup = [dev('a', 'CAM-1'), dev('c', 'CAM-1')]
    const plan = planImport([{ name: 'S', rows: [head, ['', 'CAM-1', 'bogus', '', '', ''], ['b', '', 'bogus', '', '', '']] }], [...dup, devices[1]], sets, off)
    expect(plan.unmatched[0].reason).toMatch(/matches 2/)
    expect(plan.warnings.some(w => w.includes('bogus'))).toBe(true)
    expect(plan.changed).toHaveLength(0)
  })
  it('ignores fields that do not belong to the set of the device', () => {
    const fa = dev('f', 'FA-1', { symbol_set_id: 'fa' })
    const plan = planImport([{ name: 'S', rows: [['id', 'IP', 'Notes'], ['f', '3.3.3.3', 'n']] }], [fa], sets, off)
    expect(plan.changed[0].changes.map(c => c.key)).toEqual(['notes'])
  })
})
