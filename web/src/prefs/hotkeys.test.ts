import { describe, expect, it } from 'vitest'
import { assignCombo, comboFromEvent, commandForEvent, COMMANDS, DEFAULT_HOTKEYS, findConflicts, matchCombo, resetCombo, resolveHotkeys } from './hotkeys'

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })

describe('defaults', () => {
  it('have no duplicate combos', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      expect(seen.get(c.combo), `${c.id} clashes with ${seen.get(c.combo)}`).toBeUndefined()
      seen.set(c.combo, c.id)
    }
  })
  it('follow Revu', () => {
    const d = DEFAULT_HOTKEYS
    expect([d['tool.rect'], d['tool.line'], d['tool.ellipse'], d['tool.cloud'], d['tool.text'], d['tool.freehand'], d['tool.highlight'], d['tool.measure-length']])
      .toEqual(['R', 'L', 'E', 'C', 'Q', 'P', 'H', 'M'])
    expect([d['tool.polygon'], d['tool.polyline'], d['tool.square'], d['tool.circle'], d['edit.pasteInPlace']])
      .toEqual(['Shift+P', 'Shift+N', 'Shift+R', 'Shift+E', 'Ctrl+Shift+V'])
  })
})

describe('matching', () => {
  it('matches letters case-insensitively but respects modifiers', () => {
    expect(matchCombo(ev('r'), 'R')).toBe(true)
    expect(matchCombo(ev('R', { shiftKey: true }), 'R')).toBe(false)
    expect(matchCombo(ev('R', { shiftKey: true }), 'Shift+R')).toBe(true)
    expect(matchCombo(ev('v', { ctrlKey: true }), 'Ctrl+V')).toBe(true)
    expect(matchCombo(ev('v', { metaKey: true }), 'Ctrl+V')).toBe(true)
    expect(matchCombo(ev('V', { ctrlKey: true, shiftKey: true }), 'Ctrl+V')).toBe(false)
    expect(matchCombo(ev('V', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+V')).toBe(true)
  })
  it('handles named and punctuation keys', () => {
    expect(matchCombo(ev(' '), 'Space')).toBe(true)
    expect(matchCombo(ev('+', { shiftKey: true }), '=')).toBe(true)
    expect(matchCombo(ev('='), '=')).toBe(true)
    expect(matchCombo(ev('Delete'), 'Delete')).toBe(true)
    expect(matchCombo(ev('Shift', { shiftKey: true }), 'Shift')).toBe(false)
  })
  it('resolves the command for an event', () => {
    const map = resolveHotkeys({ 'tool.rect': 'F' })
    expect(commandForEvent(ev('f'), map)).toBe('tool.rect')
    expect(commandForEvent(ev('r'), map)).toBeNull()
    expect(commandForEvent(ev('z', { ctrlKey: true }), map)).toBe('edit.undo')
    expect(commandForEvent(ev('z', { ctrlKey: true, shiftKey: true }), map)).toBe('edit.redoAlt')
  })
  it('does not trigger an unassigned command', () => {
    expect(commandForEvent(ev('r'), resolveHotkeys({ 'tool.rect': '' }))).toBeNull()
  })
})

describe('recording', () => {
  it('builds combos from events', () => {
    expect(comboFromEvent(ev('v', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+V')
    expect(comboFromEvent(ev('Delete'))).toBe('Delete')
    expect(comboFromEvent(ev('Control', { ctrlKey: true }))).toBeNull()
    expect(comboFromEvent(ev('r', { altKey: true }))).toBe('Alt+R')
  })
})

describe('conflicts', () => {
  it('finds other commands with the same combo', () => {
    const map = resolveHotkeys({})
    expect(findConflicts(map, 'tool.rect', 'L')).toEqual(['tool.line'])
    expect(findConflicts(map, 'tool.rect', 'R')).toEqual([])
    expect(findConflicts(map, 'tool.rect', '')).toEqual([])
  })
  it('reassign unassigns the previous owner; reset restores a default', () => {
    const o = assignCombo({}, 'tool.rect', 'L')
    const map = resolveHotkeys(o)
    expect(map['tool.rect']).toBe('L')
    expect(map['tool.line']).toBe('')
    expect(resolveHotkeys(resetCombo(o, 'tool.line'))['tool.line']).toBe('L')
  })
  it('drops overrides equal to the default', () => {
    expect(assignCombo({}, 'tool.rect', 'R')).toEqual({})
  })
  it('ignores unknown ids in stored overrides', () => {
    expect(resolveHotkeys({ 'bogus.cmd': 'Z' })['bogus.cmd']).toBeUndefined()
  })
})
