import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, effectivePrefs, mergePrefs, pushRecent, reorderFavorites, sanitizeStored, toggleFavorite } from './prefs'
import type { StoredPrefs } from './prefs'
import { DEFAULT_LAYOUT, movePanel, normalizeLayout, panelsIn, setPanelOpen } from './layout'

const stored = (data: StoredPrefs['data'], stamps: StoredPrefs['stamps']): StoredPrefs => ({ data, stamps })

describe('mergePrefs', () => {
  it('takes the newer value per setting', () => {
    const local = stored({ favorites: ['a'], recent: ['x'] }, { favorites: 200, recent: 100 })
    const remote = stored({ favorites: ['b'], recent: ['y'] }, { favorites: 100, recent: 300 })
    const { merged, pushNeeded, changed } = mergePrefs(local, remote)
    expect(merged.data.favorites).toEqual(['a'])
    expect(merged.data.recent).toEqual(['y'])
    expect(pushNeeded).toBe(true)
    expect(changed).toBe(true)
  })
  it('keeps settings that exist on only one side', () => {
    const { merged, pushNeeded } = mergePrefs(stored({ hotkeys: { 'tool.rect': 'F' } }, { hotkeys: 5 }), stored({ favorites: ['z'] }, { favorites: 9 }))
    expect(merged.data).toEqual({ hotkeys: { 'tool.rect': 'F' }, favorites: ['z'] })
    expect(pushNeeded).toBe(true) // the server lacks hotkeys
  })
  it('needs no push when the server is newer or equal', () => {
    const r = mergePrefs(stored({ favorites: ['a'] }, { favorites: 1 }), stored({ favorites: ['b'] }, { favorites: 2 }))
    expect(r.merged.data.favorites).toEqual(['b'])
    expect(r.pushNeeded).toBe(false)
    const tie = mergePrefs(stored({ favorites: ['a'] }, { favorites: 2 }), stored({ favorites: ['b'] }, { favorites: 2 }))
    expect(tie.merged.data.favorites).toEqual(['a'])
    expect(tie.pushNeeded).toBe(false)
    expect(tie.changed).toBe(false)
  })
  it('a fresh device adopts the server prefs', () => {
    const r = mergePrefs(stored({}, {}), stored({ listColumns: ['tag'] }, { listColumns: 7 }))
    expect(r.merged.data.listColumns).toEqual(['tag'])
    expect(r.pushNeeded).toBe(false)
    expect(r.changed).toBe(true)
  })
  it('lets a newer null (all columns) beat an older list', () => {
    const r = mergePrefs(stored({ listColumns: null }, { listColumns: 9 }), stored({ listColumns: ['tag'] }, { listColumns: 3 }))
    expect(r.merged.data.listColumns).toBeNull()
  })
})

describe('sanitizeStored', () => {
  it('drops malformed values and fills layout gaps', () => {
    const s = sanitizeStored({ data: { favorites: 'nope', recent: ['a', 1], hotkeys: { 'tool.rect': 'F', bad: 3 }, layout: { panels: { tools: { dock: 'top' } } } }, stamps: { hotkeys: 4 } })
    expect(s.data.favorites).toBeUndefined()
    expect(s.data.recent).toBeUndefined()
    expect(s.data.hotkeys).toEqual({ 'tool.rect': 'F' })
    expect(s.data.layout?.panels.tools.dock).toBe('left')
    expect(s.stamps.hotkeys).toBe(4)
  })
  it('survives garbage', () => {
    expect(sanitizeStored(null)).toEqual({ data: {}, stamps: {} })
    expect(sanitizeStored('x')).toEqual({ data: {}, stamps: {} })
  })
  it('effectivePrefs overlays defaults', () => {
    const e = effectivePrefs(sanitizeStored({ data: { favorites: ['tool:line'] }, stamps: { favorites: 1 } }))
    expect(e.favorites).toEqual(['tool:line'])
    expect(e.popupFields).toEqual(DEFAULT_PREFS.popupFields)
  })
})

describe('recent and favorites', () => {
  it('keeps the last 10, most recent first, no duplicates', () => {
    let r: string[] = []
    for (let i = 0; i < 12; i++) r = pushRecent(r, `t${i}`)
    expect(r).toHaveLength(10)
    expect(r[0]).toBe('t11')
    expect(pushRecent(r, 't5')[0]).toBe('t5')
    expect(pushRecent(r, 't5').filter(x => x === 't5')).toHaveLength(1)
  })
  it('toggles and reorders', () => {
    expect(toggleFavorite(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleFavorite(['a', 'b'], 'a')).toEqual(['b'])
    expect(reorderFavorites(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(reorderFavorites(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(reorderFavorites(['a', 'b'], 'a', 'zzz')).toEqual(['a', 'b'])
  })
})

describe('layout', () => {
  it('lists open panels per zone and moves them', () => {
    expect(panelsIn(DEFAULT_LAYOUT, 'left')).toEqual(['tools'])
    expect(panelsIn(DEFAULT_LAYOUT, 'bottom')).toEqual([])
    const moved = movePanel(DEFAULT_LAYOUT, 'markups', 'bottom')
    expect(panelsIn(moved, 'bottom')).toEqual(['markups'])
    expect(panelsIn(setPanelOpen(setPanelOpen(moved, 'pages', true), 'tools', false), 'left')).toEqual(['pages'])
  })
  it('clamps stored sizes', () => {
    expect(normalizeLayout({ sizes: { left: 5000, bottom: 1 } }).sizes).toMatchObject({ left: 600, bottom: 120 })
  })
})

describe('replaceOnOverlap pref', () => {
  it('keeps valid values and drops junk', () => {
    expect(sanitizeStored({ data: { replaceOnOverlap: 'both' } }).data.replaceOnOverlap).toBe('both')
    expect(sanitizeStored({ data: { replaceOnOverlap: 'sure' } }).data.replaceOnOverlap).toBeUndefined()
  })
})
