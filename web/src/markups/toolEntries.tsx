import type { ReactNode } from 'react'
import { icon, TOOLS } from './ToolRail'
import type { DeviceType } from '../catalog/types'
import type { Mount } from './mount'
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
  /** Device-type entries: the type this tool places. */
  typeId?: string
  /** Device-type entries: the type's default mount shape. */
  mount?: Mount
  /** Symbol-set entries: colour and icon image of the set. */
  color?: string
  image?: string
  /** Device-type entries: 1-4 character abbreviation shown under the icon in grid view. */
  initials?: string
  /** Legend-preset entries: the preset this entry places (its settings become the new legend's). */
  legendPresetId?: string
}

/** Short label for a device type: its tag prefix (letters/digits, max 4), else the first letters of its words (max 3), else the first 3 letters. */
export function entryInitials(name: string, tagPrefix?: string | null): string {
  const prefix = (tagPrefix ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4)
  if (prefix) return prefix
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length > 1) return words.slice(0, 3).map(w => w[0]).join('').toUpperCase()
  return (words[0] ?? '').slice(0, 3).toUpperCase()
}

/** Hotkey command for an entry: its built-in one, else a dynamic `tool:<entryId>` command. */
export const entryCommand = (e: { id: string; command?: string }) => e.command ?? `tool:${e.id}`

const GROUPS: Record<string, string> = {
  select: 'Select / Navigate', pan: 'Select / Navigate',
  line: 'Shapes', arrow: 'Shapes', rect: 'Shapes', ellipse: 'Shapes', cloud: 'Shapes', polyline: 'Shapes', polygon: 'Shapes', freehand: 'Shapes', highlight: 'Shapes',
  text: 'Text', stamp: 'Text',
  calibrate: 'Measure', 'measure-length': 'Measure', 'measure-polylength': 'Measure', 'measure-radius': 'Measure', 'measure-area': 'Measure', count: 'Measure',
  cable: 'Site', legend: 'Site', area: 'Site', 'area-rect': 'Site',
}

const SQUARE_ICON = icon(<rect x="5" y="5" width="14" height="14" rx="1" />)
const CIRCLE_ICON = icon(<circle cx="12" cy="12" r="7" />)

export const GROUP_ORDER = ['Select / Navigate', 'Shapes', 'Text', 'Measure', 'Site', 'Legends']

/** Everything the Tool chest lists, in display order. Device types replace the generic Device tool. */
export function buildToolEntries(sets: SymbolSet[], types: DeviceType[] = [], presets: { id: string; name: string; set_id: string | null }[] = []): ToolEntry[] {
  const base: ToolEntry[] = []
  for (const t of TOOLS) {
    if (t.tool === 'device') continue
    base.push({ id: `tool:${t.tool}`, label: t.label, group: GROUPS[t.tool] ?? 'Site', icon: t.icon, tool: t.tool, command: `tool.${t.tool}` })
    if (t.tool === 'rect') base.push({ id: 'tool:square', label: 'Square', group: 'Shapes', icon: SQUARE_ICON, tool: 'rect', shape: 'square', command: 'tool.square' })
    if (t.tool === 'ellipse') base.push({ id: 'tool:circle', label: 'Circle', group: 'Shapes', icon: CIRCLE_ICON, tool: 'ellipse', shape: 'circle', command: 'tool.circle' })
  }
  const deviceIcon = TOOLS.find(t => t.tool === 'device')!.icon
  // Set > device types: one tool per device type (the set itself is not a placeable entry)
  const devices: ToolEntry[] = [...sets].sort((a, b) => a.sort - b.sort).flatMap(s => [
    ...types.filter(t => t.symbol_set_id === s.id).sort((a, b) => a.sort - b.sort).map(t => ({
      id: `type:${t.id}`, label: t.name, group: s.name, icon: deviceIcon, tool: 'device' as Tool, setId: s.id, typeId: t.id, color: s.color, mount: t.mount, image: t.icon || s.icon, initials: entryInitials(t.name, t.tag_prefix || s.tag_prefix),
    })),
  ])
  // Legend presets: their own "Legends" group, or inside the symbol set they are attached to
  const legendIcon = TOOLS.find(t => t.tool === 'legend')!.icon
  const setName = new Map(sets.map(s => [s.id, s.name]))
  const legends: ToolEntry[] = presets.map(p => ({
    id: `legend:${p.id}`, label: p.name, group: (p.set_id && setName.get(p.set_id)) || 'Legends', icon: legendIcon, tool: 'legend' as Tool, legendPresetId: p.id,
  }))
  const inSet = (e: ToolEntry) => e.group !== 'Legends'
  const grouped = [...GROUP_ORDER.flatMap(g => base.filter(e => e.group === g)), ...legends.filter(e => !inSet(e))]
  return [...grouped, ...devices, ...legends.filter(inSet)]
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
export function activeEntryId(tool: Tool, shape: 'square' | 'circle' | null, typeId: string | null = null): string {
  if (tool === 'device') return typeId ? `type:${typeId}` : 'tool:device'
  if (tool === 'rect' && shape === 'square') return 'tool:square'
  if (tool === 'ellipse' && shape === 'circle') return 'tool:circle'
  return `tool:${tool}`
}
