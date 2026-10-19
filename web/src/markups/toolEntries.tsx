import type { ReactNode } from 'react'
import { icon, TOOLS } from './ToolRail'
import type { SymbolSet, Tool } from './types'

/** One pickable thing in the Tool chest: a tool, a shape variant, or a symbol set's device. */
export interface ToolEntry {
  id: string
  label: string
  group: string
  icon: ReactNode
  tool: Tool
  /** Hotkey command id, when the entry has one. */
  command?: string
  /** Constrain drawn rectangles/ellipses to a square / circle. */
  shape?: 'square' | 'circle'
  setId?: string
  /** Symbol-set entries: colour and icon image of the set. */
  color?: string
  image?: string
}

const GROUPS: Record<string, string> = {
  select: 'Select / Navigate', pan: 'Select / Navigate',
  line: 'Shapes', arrow: 'Shapes', rect: 'Shapes', ellipse: 'Shapes', cloud: 'Shapes', polyline: 'Shapes', polygon: 'Shapes', freehand: 'Shapes', highlight: 'Shapes',
  text: 'Text', stamp: 'Text',
  calibrate: 'Measure', 'measure-length': 'Measure', 'measure-polylength': 'Measure', 'measure-area': 'Measure', count: 'Measure',
  cable: 'Site', area: 'Site', 'area-rect': 'Site',
}

const SQUARE_ICON = icon(<rect x="5" y="5" width="14" height="14" rx="1" />)
const CIRCLE_ICON = icon(<circle cx="12" cy="12" r="7" />)

export const GROUP_ORDER = ['Select / Navigate', 'Shapes', 'Text', 'Measure', 'Site']

/** Everything the Tool chest lists, in display order. Symbol sets replace the generic Device tool. */
export function buildToolEntries(sets: SymbolSet[]): ToolEntry[] {
  const base: ToolEntry[] = []
  for (const t of TOOLS) {
    if (t.tool === 'device') continue
    base.push({ id: `tool:${t.tool}`, label: t.label, group: GROUPS[t.tool] ?? 'Site', icon: t.icon, tool: t.tool, command: `tool.${t.tool}` })
    if (t.tool === 'rect') base.push({ id: 'tool:square', label: 'Square', group: 'Shapes', icon: SQUARE_ICON, tool: 'rect', shape: 'square', command: 'tool.square' })
    if (t.tool === 'ellipse') base.push({ id: 'tool:circle', label: 'Circle', group: 'Shapes', icon: CIRCLE_ICON, tool: 'ellipse', shape: 'circle', command: 'tool.circle' })
  }
  const deviceIcon = TOOLS.find(t => t.tool === 'device')!.icon
  const devices: ToolEntry[] = [...sets].sort((a, b) => a.sort - b.sort).map(s => ({
    id: `set:${s.id}`, label: s.name, group: s.name, icon: deviceIcon, tool: 'device' as Tool, setId: s.id, color: s.color, image: s.icon,
  }))
  return [...GROUP_ORDER.flatMap(g => base.filter(e => e.group === g)), ...devices]
}

/** Groups in display order: the fixed groups, then one per symbol set. */
export function groupEntries(entries: ToolEntry[]): { name: string; entries: ToolEntry[]; isSet: boolean }[] {
  const names = [...new Set(entries.map(e => e.group))]
  return names.map(name => ({ name, entries: entries.filter(e => e.group === name), isSet: !GROUP_ORDER.includes(name) }))
}

export function matchesSearch(e: ToolEntry, q: string): boolean {
  const s = q.trim().toLowerCase()
  return !s || e.label.toLowerCase().includes(s) || e.group.toLowerCase().includes(s)
}

/** Id of the entry that is active for the current tool state. */
export function activeEntryId(tool: Tool, shape: 'square' | 'circle' | null, setId: string | null): string {
  if (tool === 'device') return setId ? `set:${setId}` : 'tool:device'
  if (tool === 'rect' && shape === 'square') return 'tool:square'
  if (tool === 'ellipse' && shape === 'circle') return 'tool:circle'
  return `tool:${tool}`
}
