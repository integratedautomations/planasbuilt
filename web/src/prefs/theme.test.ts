import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, sanitizeStored } from './prefs'
import { applyTheme, isThemePref } from './theme'

describe('theme pref', () => {
  it('defaults to auto and is sanitized', () => {
    expect(DEFAULT_PREFS.theme).toBe('auto')
    expect(isThemePref('dark')).toBe(true)
    expect(isThemePref('blue')).toBe(false)
    expect(sanitizeStored({ data: { theme: 'dark' } }).data.theme).toBe('dark')
    expect(sanitizeStored({ data: { theme: 'neon' } }).data.theme).toBeUndefined()
  })
  it('sets and clears data-theme', () => {
    const attrs = new Map<string, string>()
    const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) }
    ;(globalThis as any).document = { documentElement: root }
    applyTheme('dark'); expect(attrs.get('data-theme')).toBe('dark')
    applyTheme('auto'); expect(attrs.has('data-theme')).toBe(false)
    delete (globalThis as any).document
  })
})
