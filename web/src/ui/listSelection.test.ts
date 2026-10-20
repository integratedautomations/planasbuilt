import { describe, expect, it } from 'vitest'
import { clickSelect, emptySel, keySelect, pruneSel, selectAll } from './listSelection'

const order = ['a', 'b', 'c', 'd', 'e']
describe('listSelection', () => {
  it('plain click selects one', () => {
    expect(clickSelect(order, { selected: ['a', 'b'], anchor: 'a' }, 'c').selected).toEqual(['c'])
  })
  it('ctrl and meta toggle', () => {
    let s = clickSelect(order, emptySel<string>(), 'a')
    s = clickSelect(order, s, 'c', { ctrl: true })
    expect(s.selected).toEqual(['a', 'c'])
    s = clickSelect(order, s, 'a', { meta: true })
    expect(s.selected).toEqual(['c'])
  })
  it('shift selects range from anchor, either direction', () => {
    const s = clickSelect(order, { selected: ['b'], anchor: 'b' }, 'd', { shift: true })
    expect(s.selected).toEqual(['b', 'c', 'd'])
    expect(clickSelect(order, s, 'a', { shift: true }).selected).toEqual(['a', 'b'])
  })
  it('shift without anchor behaves like a plain click', () => {
    expect(clickSelect(order, emptySel<string>(), 'c', { shift: true }).selected).toEqual(['c'])
  })
  it('ctrl+shift adds the range', () => {
    const s = clickSelect(order, { selected: ['a', 'c'], anchor: 'c' }, 'e', { shift: true, ctrl: true })
    expect(s.selected.sort()).toEqual(['a', 'c', 'd', 'e'])
  })
  it('keys', () => {
    expect(keySelect(order, emptySel<string>(), { key: 'a', ctrlKey: true })?.selected).toEqual(order)
    expect(keySelect(order, selectAll(order), { key: 'Escape' })?.selected).toEqual([])
    expect(keySelect(order, emptySel<string>(), { key: 'Escape' })).toBeNull()
    expect(keySelect(order, emptySel<string>(), { key: 'x' })).toBeNull()
  })
  it('prunes missing ids', () => {
    expect(pruneSel(['a'], { selected: ['a', 'z'], anchor: 'z' })).toEqual({ selected: ['a'], anchor: null })
  })
})
