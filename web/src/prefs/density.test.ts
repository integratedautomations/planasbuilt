import { describe, expect, it } from 'vitest'
import { isDensityPref, resolveDensity } from './density'
import { DEFAULT_PREFS, sanitizeStored } from './prefs'

describe('density', () => {
  it('auto follows the pointer; an override wins', () => {
    expect(resolveDensity('auto', false)).toBe('compact')
    expect(resolveDensity('auto', true)).toBe('comfortable')
    expect(resolveDensity(undefined, true)).toBe('comfortable')
    expect(resolveDensity('compact', true)).toBe('compact')
    expect(resolveDensity('comfortable', false)).toBe('comfortable')
  })
  it('is stored and sanitized', () => {
    expect(DEFAULT_PREFS.density).toBe('auto')
    expect(isDensityPref('huge')).toBe(false)
    expect(sanitizeStored({ data: { density: 'compact', propsPinned: true } }).data).toMatchObject({ density: 'compact', propsPinned: true })
    expect(sanitizeStored({ data: { density: 'huge', propsPinned: 'yes' } }).data).toEqual({})
  })
})
