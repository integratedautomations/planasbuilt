import { describe, expect, it } from 'vitest'
import { data, sets } from '../catalog/fixtures'
import { activeEntryId, buildToolEntries, entryCommand, entryInitials, groupEntries } from './toolEntries'

describe('tool entries', () => {
  const entries = buildToolEntries(sets, data.device_types)
  it('lists device types but not the symbol set itself', () => {
    expect(entries.some(e => e.id.startsWith('set:'))).toBe(false)
    expect(entries.filter(e => e.setId).map(e => e.id)).toEqual(['type:ipc', 'type:sd'])
    expect(groupEntries(entries).map(g => g.name)).toContain('Cameras')
  })
  it('follows the device type sort order', () => {
    const reversed = data.device_types.map(t => (t.symbol_set_id === 'fa' ? { ...t, sort: 5 } : t)).concat([
      { id: 'a', symbol_set_id: 'fa', name: 'Alpha', icon: '', tag_prefix: null, fields: [], default_product_id: null, sort: 1 }])
    const fa = buildToolEntries(sets, reversed).filter(e => e.setId === 'fa').map(e => e.id)
    expect(fa).toEqual(['type:a', 'type:sd'])
  })
  it('marks the active device entry by type', () => {
    expect(activeEntryId('device', null, 'sd')).toBe('type:sd')
    expect(activeEntryId('device', null, null)).toBe('tool:device')
    expect(activeEntryId('rect', 'square')).toBe('tool:square')
  })
  it('derives initials for device types', () => {
    expect(entryInitials('Smoke Detector', 'sd')).toBe('SD')
    expect(entryInitials('Smoke Detector', null)).toBe('SD')
    expect(entryInitials('Pull Station Wall Mount')).toBe('PSW')
    expect(entryInitials('Camera')).toBe('CAM')
    expect(entryInitials('X', 'toolong-1')).toBe('TOOL')
    expect(entries.filter(e => e.typeId).every(e => !!e.initials)).toBe(true)
  })
  it('gives device types a dynamic hotkey command, built-ins their own', () => {
    expect(entryCommand({ id: 'type:ipc' })).toBe('tool:type:ipc')
    expect(entryCommand(entries.find(e => e.id === 'tool:rect')!)).toBe('tool.rect')
  })
})
