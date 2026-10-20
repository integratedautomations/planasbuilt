import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, normalizeLayout, panelsIn, PANEL_IDS } from './layout'

describe('layout migration', () => {
  const old = { panels: { tools: { dock: 'left', open: true }, pages: { dock: 'left', open: true }, props: { dock: 'right', open: true }, markups: { dock: 'bottom', open: true }, compare: { dock: 'right', open: false } }, sizes: { left: 250, right: 300, bottom: 200 } }
  it('adds the Areas panel to a layout saved before it existed', () => {
    const l = normalizeLayout(old)
    expect(PANEL_IDS).toContain('areas')
    expect(l.panels.areas).toEqual({ dock: 'right', open: true })
    expect(panelsIn(l, 'right')).toEqual(['props', 'areas'])
    expect(l.panels.markups).toEqual({ dock: 'bottom', open: true })
    expect(l.sizes.left).toBe(250)
  })
  it('keeps a stored Areas placement and defaults empty input', () => {
    expect(normalizeLayout({ panels: { areas: { dock: 'bottom', open: false } } }).panels.areas).toEqual({ dock: 'bottom', open: false })
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
  })
})
