import { naturalCompare } from '../markups/stacks'
import { isUniqueFieldKey } from '../markups/mixed'
import { fieldText, filterRows } from '../schedule/rows'
import type { ScheduleRow } from '../schedule/rows'
import type { Markup, Status } from '../markups/types'

/** Pure helpers behind the project Devices page: filtering, sorting, grouping and bulk edits. */

export interface DeviceFilter { search: string; setId: string; status: string; planId: string; area: string }
export const NO_DEVICE_FILTER: DeviceFilter = { search: '', setId: '', status: '', planId: '', area: '' }

export interface DeviceColumn { id: string; label: string }
export const DEVICE_COLUMNS: DeviceColumn[] = [
  { id: 'tag', label: 'Tag' },
  { id: 'set', label: 'Type' },
  { id: 'product', label: 'Product' },
  { id: 'plan', label: 'Plan' },
  { id: 'page', label: 'Page' },
  { id: 'status', label: 'Status' },
  { id: 'area', label: 'Area / room' },
  { id: 'ip', label: 'IP' },
  { id: 'mac', label: 'MAC' },
  { id: 'serial', label: 'Serial' },
  { id: 'photos', label: 'Photos' },
]

const FIELD_COLUMNS = new Set(['ip', 'mac', 'serial'])

/** Display text of a device cell. IP/MAC/serial come from the device's fields. */
export function deviceCell(r: ScheduleRow, col: string): string {
  switch (col) {
    case 'tag': return r.tag
    case 'set': return r.typeName ? `${r.setName}${r.setName ? ' · ' : ''}${r.typeName}` : r.setName
    case 'product': return r.productName
    case 'plan': return r.documentName
    case 'page': return String(r.page)
    case 'status': return r.statusLabel
    case 'area': return r.areaText
    case 'photos': return r.photos ? String(r.photos) : ''
    default: return FIELD_COLUMNS.has(col) ? fieldText(r.fields[col]) : ''
  }
}

/** Search (tag, fields, product, area...), set, status and area via the shared schedule filter, plus plan. */
export function filterDevices(rows: ScheduleRow[], f: DeviceFilter): ScheduleRow[] {
  const base = filterRows(rows, { search: f.search, setId: f.setId, status: f.status, area: f.area })
  return f.planId ? base.filter(r => r.documentId === f.planId) : base
}

/** Blanks sort last in both directions; ties fall back to natural tag order, then id. */
export function sortDevices(rows: ScheduleRow[], col: string, dir: 'asc' | 'desc'): ScheduleRow[] {
  const sign = dir === 'asc' ? 1 : -1
  const numeric = col === 'photos' || col === 'page'
  return [...rows].sort((a, b) => {
    const x = deviceCell(a, col), y = deviceCell(b, col)
    if ((x === '') !== (y === '')) return x === '' ? 1 : -1
    const c = numeric ? Number(x) - Number(y) : naturalCompare(x, y)
    return sign * c || naturalCompare(a.tag, b.tag) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

export type GroupBy = 'none' | 'plan' | 'set' | 'status' | 'room'
export const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'No grouping' }, { value: 'plan', label: 'Plan' }, { value: 'set', label: 'Symbol set' },
  { value: 'status', label: 'Status' }, { value: 'room', label: 'Room' },
]

export interface DeviceGroup { key: string; label: string; rows: ScheduleRow[] }
const NONE_LABEL: Record<Exclude<GroupBy, 'none'>, string> = { plan: 'No plan', set: 'No set', status: 'No status', room: 'No room' }

function groupKey(r: ScheduleRow, by: Exclude<GroupBy, 'none'>): string {
  switch (by) {
    case 'plan': return r.documentName
    case 'set': return r.setName
    case 'status': return r.statusLabel
    case 'room': return r.areaText
  }
}

/** Splits rows into labelled groups, keeping the incoming row order inside each. Groups sort naturally; the empty one is last. */
export function groupDevices(rows: ScheduleRow[], by: GroupBy): DeviceGroup[] {
  if (by === 'none') return [{ key: '', label: '', rows }]
  const map = new Map<string, ScheduleRow[]>()
  for (const r of rows) {
    const k = groupKey(r, by)
    const l = map.get(k)
    if (l) l.push(r); else map.set(k, [r])
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '') !== (b === '') ? (a === '' ? 1 : -1) : naturalCompare(a, b))
    .map(([key, rs]) => ({ key, label: key === '' ? NONE_LABEL[by] : key, rows: rs }))
}

/** Row ids in the order they appear on screen (after grouping), for shift-range selection. */
export const displayOrder = (groups: DeviceGroup[]) => groups.flatMap(g => g.rows.map(r => r.id))

/** Distinct plans (id and name) present in the rows, by name. */
export function planOptions(rows: ScheduleRow[]): { id: string; name: string }[] {
  const m = new Map<string, string>()
  for (const r of rows) m.set(r.documentId, r.documentName)
  return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => naturalCompare(a.name, b.name))
}

// ---- Bulk edits ----

export interface BulkResult { changed: Markup[]; skipped: number }

/** New versions of the selected devices with `status` set; devices already at that status are left out. */
export function bulkStatus(ms: Markup[], status: Status): BulkResult {
  const changed = ms.filter(m => m.type === 'device' && (m.status ?? '') !== status).map(m => ({ ...m, status }))
  return { changed, skipped: ms.length - changed.length }
}

/**
 * New versions with one field set. Fields that identify one unit (IP, MAC, serial) are refused for more than one device,
 * since the same value on several would be wrong; `skipped` then counts every device.
 */
export function bulkField(ms: Markup[], key: string, value: string | number | boolean, fieldType?: string): BulkResult {
  const devices = ms.filter(m => m.type === 'device')
  if (devices.length > 1 && isUniqueFieldKey(key, fieldType)) return { changed: [], skipped: ms.length }
  const changed = devices.filter(m => m.fields?.[key] !== value).map(m => ({ ...m, fields: { ...m.fields, [key]: value } }))
  return { changed, skipped: ms.length - changed.length }
}
