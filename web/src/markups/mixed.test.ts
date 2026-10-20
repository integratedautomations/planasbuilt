import { describe, expect, it } from 'vitest'
import { batchChanges, commonField, commonValue, isUniqueFieldKey } from './mixed'
import type { Markup } from './types'

const mk = (id: string, over: Partial<Markup> = {}) => ({ id, type: 'device', fields: {}, ...over }) as unknown as Markup

describe('commonValue', () => {
  it('returns the shared value', () => expect(commonValue([1, 1], x => x)).toEqual({ value: 1, mixed: false, count: 2 }))
  it('flags differing values as mixed', () => expect(commonValue([1, 2], x => x).mixed).toBe(true))
  it('skips inapplicable (undefined) items', () => expect(commonValue([1, 2, 1], x => (x === 2 ? undefined : x))).toEqual({ value: 1, mixed: false, count: 2 }))
  it('handles none applicable', () => expect(commonValue([1], () => undefined)).toEqual({ value: undefined, mixed: false, count: 0 }))
  it('compares objects deeply', () => expect(commonValue([{ a: 1 }, { a: 1 }], x => x).mixed).toBe(false))
})

describe('commonField', () => {
  it('treats a missing field as empty', () => {
    expect(commonField([mk('a', { fields: { x: 'q' } }), mk('b')], 'x').mixed).toBe(true)
    expect(commonField([mk('a'), mk('b')], 'x')).toMatchObject({ value: '', mixed: false })
  })
})

describe('isUniqueFieldKey', () => {
  it('flags ip/mac/serial and ip-typed fields only', () => {
    expect(isUniqueFieldKey('serial')).toBe(true)
    expect(isUniqueFieldKey('nvr_ip')).toBe(true)
    expect(isUniqueFieldKey('x', 'ip')).toBe(true)
    expect(isUniqueFieldKey('description')).toBe(false)
  })
})

describe('batchChanges', () => {
  it('patches applicable markups and drops no-ops', () => {
    const a = mk('a'), b = mk('b', { type: 'rect' } as Partial<Markup>), c = mk('c', { status: 'planned' })
    const ch = batchChanges([a, b, c], m => (m.status === 'planned' ? m : { ...m, status: 'planned' }), m => m.type === 'device')
    expect(ch.map(x => x.before.id)).toEqual(['a'])
  })
})
