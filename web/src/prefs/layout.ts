// Docking layout: which panel sits in which dock zone, which are open, and how big each zone is.

export type PanelId = 'tools' | 'pages' | 'props' | 'markups' | 'compare'
export type Dock = 'left' | 'right' | 'bottom'

export const PANEL_IDS: PanelId[] = ['tools', 'pages', 'props', 'markups', 'compare']
export const PANEL_TITLES: Record<PanelId, string> = { tools: 'Tool chest', pages: 'Pages', props: 'Properties', markups: 'Markups list', compare: 'Compare' }
export const DOCKS: Dock[] = ['left', 'right', 'bottom']

export interface PanelState { dock: Dock; open: boolean }
export interface LayoutPrefs {
  panels: Record<PanelId, PanelState>
  /** Width of the left/right zones and height of the bottom zone, in px. */
  sizes: Record<Dock, number>
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  panels: {
    tools: { dock: 'left', open: true },
    pages: { dock: 'left', open: true },
    props: { dock: 'right', open: true },
    markups: { dock: 'bottom', open: false },
    compare: { dock: 'right', open: false },
  },
  sizes: { left: 220, right: 290, bottom: 300 },
}

const clampSize = (dock: Dock, n: number) => Math.round(Math.min(dock === 'bottom' ? 800 : 600, Math.max(dock === 'bottom' ? 120 : 160, n)))

/** Fills gaps and rejects bad values in a stored layout (it may come from an older app version or another device). */
export function normalizeLayout(raw: unknown): LayoutPrefs {
  const r = (raw ?? {}) as Partial<LayoutPrefs>
  const panels = {} as Record<PanelId, PanelState>
  for (const id of PANEL_IDS) {
    const p = r.panels?.[id]
    panels[id] = {
      dock: p && DOCKS.includes(p.dock) ? p.dock : DEFAULT_LAYOUT.panels[id].dock,
      open: typeof p?.open === 'boolean' ? p.open : DEFAULT_LAYOUT.panels[id].open,
    }
  }
  const sizes = { ...DEFAULT_LAYOUT.sizes }
  for (const d of DOCKS) { const n = r.sizes?.[d]; if (typeof n === 'number' && isFinite(n)) sizes[d] = clampSize(d, n) }
  return { panels, sizes }
}

/** Open panels docked in a zone, in the registry order. */
export function panelsIn(layout: LayoutPrefs, dock: Dock): PanelId[] {
  return PANEL_IDS.filter(id => layout.panels[id].open && layout.panels[id].dock === dock)
}

export function movePanel(layout: LayoutPrefs, id: PanelId, dock: Dock): LayoutPrefs {
  return { ...layout, panels: { ...layout.panels, [id]: { dock, open: true } } }
}

export function setPanelOpen(layout: LayoutPrefs, id: PanelId, open: boolean): LayoutPrefs {
  return { ...layout, panels: { ...layout.panels, [id]: { ...layout.panels[id], open } } }
}

export function setZoneSize(layout: LayoutPrefs, dock: Dock, size: number): LayoutPrefs {
  return { ...layout, sizes: { ...layout.sizes, [dock]: clampSize(dock, size) } }
}
