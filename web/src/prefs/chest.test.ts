import { describe, expect, it } from 'vitest'
import { DEFAULT_CHEST, groupPrefs, hiddenGroupCount, moveGroup, moveItem, normalizeChest, orderBy, resetChestOrder, setGroup, showAllGroups } from './chest'
import { DEFAULT_PREFS, effectivePrefs, mergePrefs, sanitizeStored } from './prefs'

describe('tool chest prefs', () => {
  it('orders by saved keys and appends unknown ones', () => {
    expect(orderBy(['a', 'b', 'c', 'd'], x => x, ['c', 'zz', 'a'])).toEqual(['c', 'a', 'b', 'd'])
    expect(orderBy(['a', 'b'], x => x, undefined)).toEqual(['a', 'b'])
  })
  it('moves groups and items before a target or to the end', () => {
    const c = moveGroup(DEFAULT_CHEST, ['A', 'B', 'C'], 'C', 'A')
    expect(c.groupOrder).toEqual(['C', 'A', 'B'])
    expect(moveGroup(c, c.groupOrder, 'C', null).groupOrder).toEqual(['A', 'B', 'C'])
    expect(moveItem(DEFAULT_CHEST, 'A', ['x', 'y', 'z'], 'x', 'z').itemOrder).toEqual({ A: ['y', 'x', 'z'] })
    expect(moveItem(DEFAULT_CHEST, 'A', ['x'], 'nope', null).itemOrder.A).toEqual(['x'])
  })
  it('keeps per-group options with defaults, hides and shows groups, resets only the order', () => {
    expect(groupPrefs(DEFAULT_CHEST, 'A')).toEqual({ expanded: true, view: 'list', size: 'medium', hidden: false })
    let c = setGroup(DEFAULT_CHEST, 'A', { view: 'grid', size: 'large' })
    c = setGroup(c, 'A', { hidden: true })
    c = setGroup(c, 'B', { expanded: false, hidden: true })
    expect(groupPrefs(c, 'A')).toEqual({ expanded: true, view: 'grid', size: 'large', hidden: true })
    expect(hiddenGroupCount(c)).toBe(2)
    expect(hiddenGroupCount(showAllGroups(c))).toBe(0)
    c = moveGroup(c, ['A', 'B'], 'B', 'A')
    const reset = resetChestOrder(c)
    expect(reset.groupOrder).toEqual([])
    expect(groupPrefs(reset, 'A').view).toBe('grid')
  })
  it('sanitizes junk and travels through the prefs store merge', () => {
    expect(normalizeChest('x')).toEqual(DEFAULT_CHEST)
    expect(normalizeChest({ groupOrder: ['A', 1], itemOrder: { A: ['x'], B: 'no' }, groups: { A: { view: 'tiles', size: 'small', hidden: 'yes' }, B: 5 } }))
      .toEqual({ groupOrder: [], itemOrder: { A: ['x'] }, groups: { A: { size: 'small' } } })
    const chest = setGroup(DEFAULT_CHEST, 'Shapes', { view: 'grid' })
    const stored = sanitizeStored({ data: { chest }, stamps: { chest: 5 } })
    expect(effectivePrefs(stored).chest.groups.Shapes.view).toBe('grid')
    expect(DEFAULT_PREFS.chest).toEqual(DEFAULT_CHEST)
    const m = mergePrefs({ data: { chest }, stamps: { chest: 9 } }, { data: { chest: DEFAULT_CHEST }, stamps: { chest: 3 } })
    expect(m.merged.data.chest).toEqual(chest)
    expect(m.pushNeeded).toBe(true)
  })
})
