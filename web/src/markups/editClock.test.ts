import { describe, expect, it } from 'vitest'
import { applyRemoteRows, EditClock } from './editClock'
import type { Markup } from './types'

const m = (id: string, text: string) => ({ id, text }) as Markup

describe('remote rows vs newer local edits', () => {
  it('skips a remote row when the user edited the markup after the event arrived', () => {
    const clock = new EditClock()
    const stamp = clock.stamp()           // remote event arrives, async Dexie read starts
    clock.edit(['a'])                     // user commits before the read resolves
    const prev = new Map([['a', m('a', 'local')], ['b', m('b', 'old')]])
    const next = applyRemoteRows(prev, ['a', 'b'], [m('a', 'remote'), m('b', 'remote')], clock, stamp)
    expect(next.get('a')!.text).toBe('local')
    expect(next.get('b')!.text).toBe('remote')
  })
  it('applies a remote row when the local edit predates the event, and applies deletes', () => {
    const clock = new EditClock()
    clock.edit(['a'])
    const stamp = clock.stamp()
    const next = applyRemoteRows(new Map([['a', m('a', 'local')], ['b', m('b', 'x')]]), ['a', 'b'], [m('a', 'remote'), undefined], clock, stamp)
    expect(next.get('a')!.text).toBe('remote')
    expect(next.has('b')).toBe(false)
  })
})

import { MergeTracker } from './editClock'
describe('MergeTracker', () => {
  it('merges within the window, not after clear (undo/redo)', () => {
    const t = new MergeTracker()
    t.note('w', 1000)
    expect(t.canMerge('w', 1500)).toBe(true)
    expect(t.canMerge('x', 1500)).toBe(false)
    expect(t.canMerge('w', 3000)).toBe(false)
    t.clear()
    expect(t.canMerge('w', 1100)).toBe(false)
  })
})
