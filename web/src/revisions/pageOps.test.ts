import { describe, expect, it } from 'vitest'
import { highlightMarkups } from './highlight'
import { changeEntries, diffMarkups } from './diff'
import { moveOrder, revisionName } from './api'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup } from '../markups/types'
import { DEFAULT_HOTKEYS, findConflicts } from '../prefs/hotkeys'

describe('moveOrder', () => {
  it('moves a page forward and back', () => {
    expect(moveOrder(4, 1, 3)).toEqual([2, 3, 1, 4])
    expect(moveOrder(4, 4, 1)).toEqual([4, 1, 2, 3])
    expect(moveOrder(3, 2, 2)).toEqual([1, 2, 3])
  })
})

describe('revisionName', () => {
  it('shows the number, and the label when there is one', () => {
    expect(revisionName({ revision: 2 })).toBe('Rev 2')
    expect(revisionName({ revision: 3, label: 'As-built' })).toBe('Rev 3 · As-built')
  })
})

describe('highlightMarkups', () => {
  const m = (id: string, x: number): Markup => ({
    id, document_id: 'd', page: 1, type: 'rect', text: '', layer_id: null, style: { ...DEFAULT_STYLE },
    geometry: { x, y: 10, width: 20, height: 20, rotation: 0 },
  })
  it('outlines the old spot on the old side and the new spot on the new side', () => {
    const a = m('a', 10)
    const entries = changeEntries(diffMarkups([a], [{ ...a, geometry: { x: 100, y: 10, width: 20, height: 20, rotation: 0 } }]))
    const old = highlightMarkups(entries, 1, 'old')
    const next = highlightMarkups(entries, 1, 'new')
    expect(old).toHaveLength(1)
    expect(next).toHaveLength(1)
    expect((old[0].geometry as any).x).toBeLessThan((next[0].geometry as any).x)
    expect(highlightMarkups(entries, 2, 'both')).toHaveLength(0)
  })
  it('colours added green and removed red', () => {
    const entries = changeEntries(diffMarkups([m('gone', 0)], [m('new', 200)]))
    expect(highlightMarkups(entries, 1, 'new')[0].style.stroke).toBe('#2f9e44')
    expect(highlightMarkups(entries, 1, 'old')[0].style.stroke).toBe('#e03131')
  })
})

describe('hotkeys', () => {
  it('registers Print on Ctrl+P without conflicts', () => {
    expect(DEFAULT_HOTKEYS['file.print']).toBe('Ctrl+P')
    expect(findConflicts(DEFAULT_HOTKEYS, 'file.print', 'Ctrl+P')).toEqual([])
    expect(findConflicts(DEFAULT_HOTKEYS, 'panel.compare', DEFAULT_HOTKEYS['panel.compare'])).toEqual([])
  })
})
