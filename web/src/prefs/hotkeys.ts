// Central hotkey registry: command id -> default combo (Revu-style), plus matching, recording and conflict helpers.
// A combo is a "+"-joined string such as "Ctrl+Shift+V". Ctrl also matches Cmd on macOS.

export interface Command { id: string; label: string; group: string; combo: string }

const tool = (t: string, label: string, combo: string): Command => ({ id: `tool.${t}`, label, group: 'Tools', combo })

export const COMMANDS: Command[] = [
  tool('select', 'Select', 'V'),
  tool('pan', 'Pan', 'Shift+H'),
  tool('rect', 'Rectangle', 'R'),
  tool('square', 'Square', 'Shift+R'),
  tool('ellipse', 'Ellipse', 'E'),
  tool('circle', 'Circle', 'Shift+E'),
  tool('line', 'Line', 'L'),
  tool('arrow', 'Arrow', 'A'),
  tool('cloud', 'Cloud', 'C'),
  tool('text', 'Callout / text box', 'Q'),
  tool('freehand', 'Pen (freehand)', 'P'),
  tool('highlight', 'Highlight', 'H'),
  tool('polygon', 'Polygon', 'Shift+P'),
  tool('polyline', 'Polyline', 'Shift+N'),
  tool('measure-length', 'Measure length', 'M'),
  tool('measure-polylength', 'Measure polylength', 'N'),
  tool('measure-area', 'Measure area', 'B'),
  tool('measure-radius', 'Measure radius', 'Shift+M'),
  tool('count', 'Count', 'O'),
  tool('calibrate', 'Calibrate scale', 'K'),
  tool('device', 'Device', 'D'),
  tool('cable', 'Cable run', 'W'),
  tool('stamp', 'Stamp', 'S'),
  tool('area', 'Area (click points)', 'J'),
  tool('area-rect', 'Area (drag rectangle)', 'U'),
  tool('legend', 'Legend', 'Alt+L'),
  { id: 'edit.undo', label: 'Undo', group: 'Edit', combo: 'Ctrl+Z' },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', combo: 'Ctrl+Y' },
  { id: 'edit.redoAlt', label: 'Redo (alternate)', group: 'Edit', combo: 'Ctrl+Shift+Z' },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', combo: 'Ctrl+X' },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', combo: 'Ctrl+C' },
  { id: 'edit.paste', label: 'Paste', group: 'Edit', combo: 'Ctrl+V' },
  { id: 'edit.pasteInPlace', label: 'Paste in place', group: 'Edit', combo: 'Ctrl+Shift+V' },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', combo: 'Ctrl+D' },
  { id: 'edit.delete', label: 'Delete', group: 'Edit', combo: 'Delete' },
  { id: 'edit.deleteAlt', label: 'Delete (alternate)', group: 'Edit', combo: 'Backspace' },
  { id: 'edit.selectAll', label: 'Select all', group: 'Edit', combo: 'Ctrl+A' },
  { id: 'edit.escape', label: 'Cancel / deselect', group: 'Edit', combo: 'Escape' },
  { id: 'edit.finish', label: 'Finish drawing', group: 'Edit', combo: 'Enter' },
  { id: 'select.boxMode', label: 'Toggle box select', group: 'Edit', combo: 'X' },
  { id: 'view.panHold', label: 'Pan (hold)', group: 'View', combo: 'Space' },
  { id: 'view.zoomIn', label: 'Zoom in', group: 'View', combo: '=' },
  { id: 'view.zoomOut', label: 'Zoom out', group: 'View', combo: '-' },
  { id: 'view.fit', label: 'Fit page', group: 'View', combo: '0' },
  { id: 'view.focus', label: 'Focus mode (hide panels)', group: 'View', combo: 'F' },
  { id: 'view.nextPage', label: 'Next page', group: 'View', combo: 'PageDown' },
  { id: 'view.prevPage', label: 'Previous page', group: 'View', combo: 'PageUp' },
  { id: 'panel.markups', label: 'Toggle Markups list', group: 'Panels', combo: 'Shift+L' },
  { id: 'panel.tools', label: 'Toggle Tool chest', group: 'Panels', combo: 'Shift+T' },
  { id: 'panel.props', label: 'Toggle Properties', group: 'Panels', combo: 'Shift+I' },
  { id: 'panel.pages', label: 'Toggle Pages', group: 'Panels', combo: 'Shift+G' },
  { id: 'panel.compare', label: 'Toggle Compare revisions', group: 'Panels', combo: 'Shift+C' },
  { id: 'panel.areas', label: 'Toggle Areas', group: 'Panels', combo: 'Shift+A' },
  { id: 'panel.layers', label: 'Toggle Layers', group: 'Panels', combo: 'Shift+Y' },
  { id: 'file.print', label: 'Print', group: 'File', combo: 'Ctrl+P' },
]

export const DEFAULT_HOTKEYS: Record<string, string> = Object.fromEntries(COMMANDS.map(c => [c.id, c.combo]))

/** Dynamic "activate this Tool chest entry" commands (device types, products...) look like `tool:<entryId>`; they have no default. */
export const isDynamicCommand = (id: string) => id.startsWith('tool:') && id.length > 5
export const dynamicCommand = (entryId: string) => `tool:${entryId}`
export const entryIdOfCommand = (cmd: string) => (isDynamicCommand(cmd) ? cmd.slice(5) : null)

/** Effective map: defaults overlaid with the user's overrides ('' = unassigned). Unknown static command ids are dropped; dynamic tool commands are kept. */
export function resolveHotkeys(overrides: Record<string, string> | undefined): Record<string, string> {
  const out = { ...DEFAULT_HOTKEYS }
  for (const [id, combo] of Object.entries(overrides ?? {})) if ((id in out || isDynamicCommand(id)) && typeof combo === 'string') out[id] = combo
  return out
}

const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']
const KEY_NAMES: Record<string, string> = { ' ': 'Space', '+': '=', Esc: 'Escape', Del: 'Delete' }

/** Name of the non-modifier key in a keyboard event, normalised: letters upper-case, "+" folded into "=". */
export function keyName(e: { key: string }): string {
  const k = KEY_NAMES[e.key] ?? e.key
  return k.length === 1 ? k.toUpperCase() : k
}

interface Parsed { ctrl: boolean; shift: boolean; alt: boolean; key: string }

export function parseCombo(combo: string): Parsed | null {
  if (!combo) return null
  const parts = combo.split('+')
  const key = parts.pop() ?? ''
  if (!key) return null
  const mods = new Set(parts)
  return { ctrl: mods.has('Ctrl'), shift: mods.has('Shift'), alt: mods.has('Alt'), key }
}

/** True for shifted punctuation (=, -, ...) where Shift is part of how the key is typed, not a modifier choice. */
const shiftIsIncidental = (key: string) => key.length === 1 && !/[A-Z0-9]/.test(key)

export type KeyEventLike = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

export function matchCombo(e: KeyEventLike, combo: string): boolean {
  const p = parseCombo(combo)
  if (!p || MODIFIER_KEYS.includes(e.key)) return false
  if (keyName(e) !== p.key) return false
  if ((e.ctrlKey || e.metaKey) !== p.ctrl || e.altKey !== p.alt) return false
  return shiftIsIncidental(p.key) || e.shiftKey === p.shift
}

/** The command a key event triggers under the given map, or null. First match in registry order wins. */
export function commandForEvent(e: KeyEventLike, map: Record<string, string>): string | null {
  for (const c of COMMANDS) if (map[c.id] && matchCombo(e, map[c.id])) return c.id
  for (const [id, combo] of Object.entries(map)) if (isDynamicCommand(id) && combo && matchCombo(e, combo)) return id
  return null
}

/** Combo string for a key press while recording a new hotkey; null for a bare modifier press. */
export function comboFromEvent(e: KeyEventLike): string | null {
  if (MODIFIER_KEYS.includes(e.key)) return null
  const key = keyName(e)
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey && !shiftIsIncidental(key)) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** Other commands already using this combo. */
export function findConflicts(map: Record<string, string>, id: string, combo: string): string[] {
  if (!combo) return []
  return Object.keys(map).filter(k => k !== id && map[k] === combo)
}

/** Drops overrides equal to the default so the stored object stays small. */
export function tidyOverrides(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([id, c]) => (id in DEFAULT_HOTKEYS ? DEFAULT_HOTKEYS[id] !== c : isDynamicCommand(id) && !!c)))
}

/** Assigns a combo to a command, unassigning (reassigning away from) any conflicting command. Returns overrides. */
export function assignCombo(overrides: Record<string, string>, id: string, combo: string): Record<string, string> {
  const map = resolveHotkeys(overrides)
  const next = { ...overrides }
  for (const other of findConflicts(map, id, combo)) next[other] = ''
  next[id] = combo
  return tidyOverrides(next)
}

/** Resets one command to its default. */
export function resetCombo(overrides: Record<string, string>, id: string): Record<string, string> {
  const next = { ...overrides }
  delete next[id]
  return next
}

export function formatCombo(combo: string): string {
  return combo ? combo.split('+').join(' + ') : 'Unassigned'
}

/** What recording a combo for a command leads to: an assignment, or a clash to confirm first. */
export function recordCombo(overrides: Record<string, string>, id: string, combo: string): { conflicts: string[]; overrides: Record<string, string> } {
  return { conflicts: findConflicts(resolveHotkeys(overrides), id, combo), overrides: assignCombo(overrides, id, combo) }
}

export const commandLabel = (id: string) => COMMANDS.find(c => c.id === id)?.label ?? id

/** Hotkeys are ignored while the user is typing. */
export function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  if (!t || !t.tagName) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true
}
