import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_UNITS, formatArea, formatLength, getUnits, normalizeUnits, setUnits } from './units'

afterEach(() => setUnits(DEFAULT_UNITS))

describe('formatLength', () => {
  it('defaults to feet-inches rounded to 1/2"', () => {
    expect(getUnits()).toEqual({ mode: 'ftin', round: 2 })
    expect(formatLength(12.5)).toBe(`12'-6"`)
    expect(formatLength(12 + 6.5 / 12)).toBe(`12'-6 1/2"`)
    expect(formatLength(0.5 / 12)).toBe(`0'-1/2"`)
    expect(formatLength(-3)).toBe(`0'-0"`)
  })
  it('rounds to the nearest inch', () => {
    expect(formatLength(1 + 6.4 / 12, { mode: 'ftin', round: 1 })).toBe(`1'-6"`)
    expect(formatLength(1 + 6.6 / 12, { mode: 'ftin', round: 1 })).toBe(`1'-7"`)
  })
  it('rounds to 1/4" and reduces fractions', () => {
    const u = { mode: 'ftin', round: 4 } as const
    expect(formatLength(3 / 12 + 1 / 48, u)).toBe(`0'-3 1/4"`)
    expect(formatLength(3 / 12 + 2 / 48, u)).toBe(`0'-3 1/2"`)
    expect(formatLength(3 / 12 + 3 / 48, u)).toBe(`0'-3 3/4"`)
    expect(formatLength(0.25 / 12, u)).toBe(`0'-1/4"`)
  })
  it('carries rounding up to the next foot', () => {
    expect(formatLength(2 - 0.1 / 12, { mode: 'ftin', round: 2 })).toBe(`2'-0"`)
  })
  it('formats decimal feet', () => {
    expect(formatLength(12.5, { mode: 'decimal', round: 2 })).toBe('12.50 ft')
    expect(formatLength(10 + 1 / 12 + 0.001, { mode: 'decimal', round: 1 })).toBe('10.08 ft')
  })
  it('follows setUnits', () => {
    setUnits({ mode: 'decimal', round: 1 })
    expect(formatLength(5)).toBe('5.00 ft')
  })
})

describe('normalizeUnits', () => {
  it('fills in defaults for junk', () => {
    expect(normalizeUnits(null)).toEqual(DEFAULT_UNITS)
    expect(normalizeUnits({ mode: 'meters', round: 3 })).toEqual(DEFAULT_UNITS)
    expect(normalizeUnits({ mode: 'decimal', round: 4 })).toEqual({ mode: 'decimal', round: 4 })
  })
})

describe('formatArea', () => {
  it('shows SF with one decimal', () => expect(formatArea(1234.56)).toBe('1,234.6 SF'))
})
