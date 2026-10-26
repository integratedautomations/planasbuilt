import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, LAYOUT_VERSION, normalizeLayout, panelsIn, PANEL_IDS, propsVisible } from './layout'

describe('layout migration', () => {
  const old = { panels: { tools: { dock: 'left', open: true }, pages: { dock: 'left', open: false }, props: { dock: 'right', open: true }, markups: { dock: 'bottom', open: true }, compare: { dock: 'right', open: true } }, sizes: { left: 250, right: 300, bottom: 200 } }
  it('old layouts keep docking but take the new open defaults once, and gain Layers', () => {
    const l = normalizeLayout(old)
    expect(PANEL_IDS).toContain('layers')
    expect(PANEL_IDS).toContain('cables')
    expect(DEFAULT_LAYOUT.panels.cables.dock).toBe('bottom')
    expect(l.version).toBe(LAYOUT_VERSION)
    expect(l.panels.markups).toEqual({ dock: 'bottom', open: false })
    expect(l.panels.props).toEqual({ dock: 'right', open: false })
    expect(l.panels.pages).toEqual({ dock: 'left', open: false })
    expect(l.panels.compare.open).toBe(false)
    expect(l.panels.layers).toEqual({ dock: 'right', open: false })
    expect(l.panels.areas).toEqual({ dock: 'right', open: false })
    expect(l.sizes.left).toBe(250)
  })
  it('keeps a moved dock through the migration', () => {
    expect(normalizeLayout({ panels: { areas: { dock: 'bottom', open: true } } }).panels.areas).toEqual({ dock: 'bottom', open: false })
  })
  it('current-version layouts keep the stored open state', () => {
    const l = normalizeLayout({ version: LAYOUT_VERSION, panels: { markups: { dock: 'bottom', open: true }, layers: { dock: 'left', open: true } } })
    expect(l.panels.markups.open).toBe(true)
    expect(l.panels.layers).toEqual({ dock: 'left', open: true })
    expect(normalizeLayout(l)).toEqual(l)
  })
  it('defaults empty input; default zones are the Tool chest on the left, Pages and the rest closed', () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(panelsIn(DEFAULT_LAYOUT, 'left')).toEqual(['tools'])
    expect(panelsIn(DEFAULT_LAYOUT, 'right')).toEqual([])
  })
})

describe('Properties auto-open', () => {
  const base = { hasSelection: false, pinned: false, manualOpen: false, dismissed: false }
  it('opens with a selection and closes without one', () => {
    expect(propsVisible(base)).toBe(false)
    expect(propsVisible({ ...base, hasSelection: true })).toBe(true)
  })
  it('stays open when pinned or opened by hand', () => {
    expect(propsVisible({ ...base, pinned: true })).toBe(true)
    expect(propsVisible({ ...base, manualOpen: true })).toBe(true)
  })
  it('a dismissed panel stays shut for that selection', () => {
    expect(propsVisible({ ...base, hasSelection: true, dismissed: true })).toBe(false)
  })
})
