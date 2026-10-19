import { HARDWARE_FIELDS, STATUSES } from '../markups/types'
import type { FieldDef, Markup, Status, SymbolSet } from '../markups/types'

/** What a spreadsheet header maps to. Field targets are resolved per device, since sets differ. */
export type Target =
  | { kind: 'id' }
  | { kind: 'tag' }
  | { kind: 'status' }
  | { kind: 'field'; norm: string }
  | { kind: 'ignored' }   // known export columns that are read-only (Area, Document, Placed by...)
  | { kind: 'unknown' }

export interface ColumnMap { index: number; header: string; target: Target }

export const normalizeHeader = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

const NOTES_DEF: FieldDef = { key: 'notes', label: 'Notes', type: 'text' }
const READ_ONLY = new Set(['set', 'type', 'area', 'area1', 'area2', 'area3', 'document', 'page', 'sheet', 'placedby', 'placedat',
  'lasteditedby', 'lasteditedat', 'updated', 'photos', 'photoscount', 'photocount'])

/** The field definitions a device can take from a spreadsheet: its set's fields, then hardware and notes. */
export function fieldDefsFor(set: SymbolSet | undefined): FieldDef[] {
  const defs = [...(set?.fields ?? [])]
  const seen = new Set(defs.map(f => f.key))
  for (const f of [...HARDWARE_FIELDS, NOTES_DEF]) if (!seen.has(f.key)) defs.push(f)
  return defs
}

/** Does this header text (normalised) name this field, by label or key? "Model #" and "model" both hit. */
const namesField = (norm: string, f: FieldDef) => norm === normalizeHeader(f.label) || norm === normalizeHeader(f.key)

export function mapHeaders(headers: unknown[], sets: SymbolSet[]): ColumnMap[] {
  const allDefs = [...sets.flatMap(s => s.fields), ...HARDWARE_FIELDS, NOTES_DEF]
  const claimedId = { id: false, tag: false, status: false }
  return headers.map((h, index) => {
    const header = String(h ?? '').trim()
    const norm = normalizeHeader(header)
    let target: Target = { kind: 'unknown' }
    if (!norm) target = { kind: 'ignored' }
    else if (norm === 'id' || norm === 'markupid' || norm === 'deviceid') { if (!claimedId.id) { claimedId.id = true; target = { kind: 'id' } } }
    else if (norm === 'tag') { if (!claimedId.tag) { claimedId.tag = true; target = { kind: 'tag' } } }
    else if (norm === 'status') { if (!claimedId.status) { claimedId.status = true; target = { kind: 'status' } } }
    else if (allDefs.some(f => namesField(norm, f))) target = { kind: 'field', norm }
    else if (READ_ONLY.has(norm)) target = { kind: 'ignored' }
    return { index, header, target }
  })
}

/** "Installed", "installed", " PUNCH " -> status value; blank -> ''; unknown -> null. */
export function parseStatus(v: unknown): Status | null {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return ''
  const hit = STATUSES.find(x => x.value === s || x.label.toLowerCase() === s)
  return hit ? hit.value : null
}

const pad = (n: number) => String(n).padStart(2, '0')
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/** Cell -> stored field value, or undefined when it cannot be read for this field type. */
export function coerceField(v: unknown, def: FieldDef): string | number | boolean | undefined {
  if (def.type === 'checkbox') {
    if (typeof v === 'boolean') return v
    const s = String(v).trim().toLowerCase()
    if (['yes', 'y', 'true', '1', 'x', 'checked'].includes(s)) return true
    if (['no', 'n', 'false', '0', ''].includes(s)) return false
    return undefined
  }
  if (def.type === 'number') {
    if (typeof v === 'number') return v
    const n = Number(String(v).trim())
    return String(v).trim() !== '' && !isNaN(n) ? n : undefined
  }
  if (def.type === 'date') {
    if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    return String(v).trim()
  }
  if (def.type === 'select' && def.options?.length) {
    const s = String(v).trim().toLowerCase()
    const hit = def.options.find(o => o.toLowerCase() === s)
    return hit ?? undefined
  }
  if (v instanceof Date) return v.toISOString()
  return String(v).trim()
}

export interface FieldChange { key: string; label: string; old: string; next: string }
export interface DeviceChange {
  markup: Markup
  /** Row number in the spreadsheet (1-based, header = 1). */
  row: number
  changes: FieldChange[]
  after: Markup
}
export interface UnmatchedRow { sheet: string; row: number; label: string; reason: string }
export interface ImportSheet { name: string; rows: unknown[][] }
export interface ImportPlan {
  columns: ColumnMap[]
  sheetsUsed: string[]
  matched: number
  /** Matched devices with at least one change. */
  changed: DeviceChange[]
  unmatched: UnmatchedRow[]
  warnings: string[]
}
export interface ImportOptions { clearBlanks: boolean }

const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v === undefined || v === null ? '' : String(v))

/**
 * Matches spreadsheet rows to devices (by `id` first, then by Tag) and works out what would change.
 * Sheets without an id or Tag column are skipped. A device found in several sheets (e.g. "All devices"
 * and its set sheet) is only handled once. New devices are never created.
 */
export function planImport(sheets: ImportSheet[], devices: Markup[], sets: SymbolSet[], opts: ImportOptions): ImportPlan {
  const setById = new Map(sets.map(s => [s.id, s]))
  const byId = new Map(devices.map(d => [d.id, d]))
  const byTag = new Map<string, Markup[]>()
  for (const d of devices) {
    const t = (d.tag ?? '').trim().toLowerCase()
    if (!t) continue
    const l = byTag.get(t)
    if (l) l.push(d); else byTag.set(t, [d])
  }
  const plan: ImportPlan = { columns: [], sheetsUsed: [], matched: 0, changed: [], unmatched: [], warnings: [] }
  const done = new Set<string>()
  const warned = new Set<string>()
  const warn = (s: string) => { if (!warned.has(s) && warned.size < 20) { warned.add(s); plan.warnings.push(s) } }

  for (const sheet of sheets) {
    if (!sheet.rows.length) continue
    const columns = mapHeaders(sheet.rows[0], sets)
    const idCol = columns.find(c => c.target.kind === 'id')
    const tagCol = columns.find(c => c.target.kind === 'tag')
    if (!idCol && !tagCol) continue
    plan.sheetsUsed.push(sheet.name)
    if (!plan.columns.length) plan.columns = columns
    const statusCol = columns.find(c => c.target.kind === 'status')
    const fieldCols = columns.filter(c => c.target.kind === 'field')

    for (let r = 1; r < sheet.rows.length; r++) {
      const cells = sheet.rows[r]
      if (!cells || cells.every(isBlank)) continue
      const idVal = idCol ? String(cells[idCol.index] ?? '').trim() : ''
      const tagVal = tagCol ? String(cells[tagCol.index] ?? '').trim() : ''
      let dev: Markup | undefined
      if (idVal) dev = byId.get(idVal)
      if (!dev && tagVal) {
        const hits = byTag.get(tagVal.toLowerCase()) ?? []
        if (hits.length === 1) dev = hits[0]
        else if (hits.length > 1) {
          plan.unmatched.push({ sheet: sheet.name, row: r + 1, label: tagVal, reason: `Tag matches ${hits.length} devices` })
          continue
        }
      }
      if (!dev) {
        plan.unmatched.push({ sheet: sheet.name, row: r + 1, label: tagVal || idVal || `row ${r + 1}`, reason: 'No matching device' })
        continue
      }
      if (done.has(dev.id)) continue
      done.add(dev.id)
      plan.matched++

      const set = dev.symbol_set_id ? setById.get(dev.symbol_set_id) : undefined
      const defs = fieldDefsFor(set)
      const changes: FieldChange[] = []
      let status: Status = dev.status ?? ''
      const fields = { ...(dev.fields ?? {}) }

      if (statusCol) {
        const raw = cells[statusCol.index]
        if (isBlank(raw)) {
          if (opts.clearBlanks && status !== '') { changes.push({ key: 'status', label: 'Status', old: statusLabelOf(status), next: '' }); status = '' }
        } else {
          const parsed = parseStatus(raw)
          if (parsed === null) warn(`Unknown status "${String(raw).trim()}" ignored`)
          else if (parsed !== status) { changes.push({ key: 'status', label: 'Status', old: statusLabelOf(status), next: statusLabelOf(parsed) }); status = parsed }
        }
      }

      for (const col of fieldCols) {
        const norm = (col.target as { norm: string }).norm
        const def = defs.find(f => namesField(norm, f))
        if (!def) continue // a field of some other set; not applicable to this device
        const raw = cells[col.index]
        const old = fields[def.key]
        if (isBlank(raw)) {
          if (opts.clearBlanks && !isBlank(old)) {
            changes.push({ key: def.key, label: def.label, old: show(old), next: '' })
            fields[def.key] = ''
          }
          continue
        }
        const next = coerceField(raw, def)
        if (next === undefined) { warn(`${def.label}: "${String(raw).trim()}" is not a valid ${def.type} value, ignored`); continue }
        if (show(next) !== show(old) && !(isBlank(old) && next === false)) {
          changes.push({ key: def.key, label: def.label, old: show(old), next: show(next) })
          fields[def.key] = next
        }
      }
      if (changes.length) plan.changed.push({ markup: dev, row: r + 1, changes, after: { ...dev, status, fields } })
    }
  }
  return plan
}

const statusLabelOf = (s: string) => STATUSES.find(x => x.value === s)?.label ?? ''
