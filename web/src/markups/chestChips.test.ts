import { beforeEach, describe, expect, it, vi } from 'vitest'
import { data, sets } from '../catalog/fixtures'
import { buildToolEntries } from './toolEntries'
import { chestOfEntry, chestOptions, chipLabel, loadChest, resolveChest, saveChest } from './chestChips'

const entries = buildToolEntries(sets, data.device_types)

describe('phone chest row', () => {
  it('lists pinned lists only when they have entries, then groups, then symbol sets', () => {
    const none = chestOptions(entries, [], [])
    expect(none.map(o => o.id)).not.toContain('favorites')
    expect(none.map(o => o.label)).toContain('Shapes')
    expect(none.map(o => o.label)).toContain('Measure')
    expect(none.some(o => o.label === 'Select / Navigate')).toBe(false)
    expect(none.filter(o => o.id.startsWith('set:')).length).toBeGreaterThan(0)
    const some = chestOptions(entries, ['type:sd', 'gone'], ['tool:line'])
    expect(some[0]).toMatchObject({ id: 'favorites' })
    expect(some[0].entries.map(e => e.id)).toEqual(['type:sd'])
    expect(some[1]).toMatchObject({ id: 'recent' })
  })
  it('is empty for read-only viewers', () => {
    expect(chestOptions(entries, ['type:sd'], [], true)).toEqual([])
  })
  it('resolves the saved chest, falling back to the first symbol set', () => {
    const opts = chestOptions(entries, [], [])
    expect(resolveChest(opts, 'group:Measure')?.label).toBe('Measure')
    expect(resolveChest(opts, 'set:missing')?.id.startsWith('set:')).toBe(true)
    expect(resolveChest(opts, null)?.id.startsWith('set:')).toBe(true)
    expect(resolveChest([], 'x')).toBeNull()
  })
  it('finds the chest of an entry, ignoring Favorites and Recent', () => {
    const opts = chestOptions(entries, ['type:sd'], ['type:sd'])
    expect(chestOfEntry(opts, 'type:sd')?.id).toBe('set:fa')
    expect(chestOfEntry(opts, 'tool:line')?.id).toBe('group:Shapes')
    expect(chestOfEntry(opts, null)).toBeNull()
  })
  it('labels chips with initials', () => {
    expect(chipLabel(entries.find(e => e.id === 'type:sd')!)).toBe('SD')
    expect(chipLabel(entries.find(e => e.id === 'tool:rect')!)).toBe('REC')
  })
  describe('remembers the last chest per project', () => {
    beforeEach(() => {
      const m = new Map<string, string>()
      vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } })
    })
    it('round-trips and keeps projects apart', () => {
      expect(loadChest('p1')).toBeNull()
      saveChest('p1', 'set:fa'); saveChest('p2', 'group:Shapes')
      expect(loadChest('p1')).toBe('set:fa')
      expect(loadChest('p2')).toBe('group:Shapes')
    })
  })
})
