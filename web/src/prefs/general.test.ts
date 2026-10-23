import { describe, expect, it } from 'vitest'
import { DEFAULT_GENERAL, labelVisible, normalizeGeneral } from './general'
import { DEFAULT_PREFS, effectivePrefs, sanitizeStored } from './prefs'

describe('normalizeGeneral', () => {
  it('returns the defaults for junk and for missing keys', () => {
    expect(normalizeGeneral(null)).toEqual(DEFAULT_GENERAL)
    expect(normalizeGeneral([])).toEqual(DEFAULT_GENERAL)
    expect(normalizeGeneral({ labels: 'zoomed' })).toEqual({ ...DEFAULT_GENERAL, labels: 'zoomed' })
  })
  it('rejects out-of-range and wrong-typed values one by one', () => {
    const g = normalizeGeneral({ rotateStep: 7, wheelSpeed: 99, longPressMs: 5, pencil: 'x', haptics: 'yes', coverageOpacity: 5, afterPlace: 'select' })
    expect(g).toEqual({ ...DEFAULT_GENERAL, afterPlace: 'select' })
  })
  it('keeps valid values', () => {
    const g = normalizeGeneral({ rotateStep: 0, wheelSpeed: 2, longPressMs: 700.4, coverageOpacity: 0.3, middlePan: false })
    expect(g).toMatchObject({ rotateStep: 0, wheelSpeed: 2, longPressMs: 700, coverageOpacity: 0.3, middlePan: false })
  })
})

describe('labelVisible', () => {
  it('follows the mode', () => {
    expect(labelVisible('always', 0.01)).toBe(true)
    expect(labelVisible('never', 5)).toBe(false)
    expect(labelVisible('zoomed', 0.3)).toBe(false)
    expect(labelVisible('zoomed', 1)).toBe(true)
  })
})

describe('prefs migration', () => {
  it('old stored prefs without the new keys get the defaults', () => {
    const p = effectivePrefs(sanitizeStored({ data: { theme: 'dark' }, stamps: { theme: 5 } }))
    expect(p.theme).toBe('dark')
    expect(p.general).toEqual(DEFAULT_GENERAL)
    expect(p.units).toEqual({ mode: 'ftin', round: 2 })
    expect(DEFAULT_PREFS.general).toEqual(DEFAULT_GENERAL)
  })
  it('sanitizes stored general and units', () => {
    const s = sanitizeStored({ data: { general: { labels: 'never', wheelSpeed: -1 }, units: { mode: 'decimal', round: 9 } }, stamps: {} })
    expect(s.data.general).toEqual({ ...DEFAULT_GENERAL, labels: 'never' })
    expect(s.data.units).toEqual({ mode: 'decimal', round: 2 })
  })
})
