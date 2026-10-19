import { areaPathIn, buildAreaIndex, isArea, isSheetArea } from '../markups/areas'
import { detectStacks, naturalCompare } from '../markups/stacks'
import { feetOf, formatArea, formatFeetInches, sqftOf } from '../markups/measure'
import { HARDWARE_FIELDS, STATUSES } from '../markups/types'
import type { FieldDef, Markup, SymbolSet } from '../markups/types'
import { productLabel } from '../catalog/catalog'
import type { Catalog } from '../catalog/catalog'

export const AREA_SEP = ' > '
export const MEASURE_TYPES = ['measure-length', 'measure-polylength', 'measure-area', 'cable']

export interface ScheduleRow {
  id: string
  markup: Markup
  type: string
  isDevice: boolean
  tag: string
  setId: string
  setName: string
  typeId: string
  typeName: string
  productId: string
  /** "Manufacturer Model" of the assigned product. */
  productName: string
  status: string
  statusLabel: string
  areaPath: string[]
  areaText: string
  documentId: string
  documentName: string
  page: number
  sheet: string
  placedBy: string
  placedAt: string
  editedBy: string
  editedAt: string
  photos: number
  fields: Record<string, string | number | boolean>
  /** Measurement value or text content, for non-device rows. */
  value: string
  valueNum: number | null
  unit: string
  /** Size of the stack this device belongs to (1 = alone). */
  stackSize: number
}

export interface BuildContext {
  symbolSets: Map<string, SymbolSet>
  /** Device types and products, for the Type and Product columns. */
  catalog?: Catalog
  /** Fallback names for documents (a markup's own document_name wins). */
  docNames?: Map<string, string>
  /** Photo counts by markup id, used when a markup carries none. */
  photoCounts?: Map<string, number>
  /** Points per foot for a sheet, or null when unscaled. */
  scaleFor?: (documentId: string, page: number) => number | null
  /** Include non-device markups (areas are never included). */
  showAll?: boolean
}

export const statusLabel = (s: string | undefined) => STATUSES.find(x => x.value === s)?.label ?? ''

export function measurement(m: Markup, ppf: number | null): { value: string; num: number | null; unit: string } {
  if (m.type === 'text') return { value: m.text, num: null, unit: '' }
  if (!MEASURE_TYPES.includes(m.type) || !('points' in m.geometry)) return { value: m.text, num: null, unit: '' }
  if (!ppf) return { value: 'No scale', num: null, unit: '' }
  if (m.type === 'measure-area') { const v = sqftOf(m.geometry.points, ppf); return { value: formatArea(v), num: v, unit: 'SF' } }
  const v = feetOf(m.geometry.points, ppf)
  return { value: formatFeetInches(v), num: v, unit: 'ft' }
}

/** Builds list rows from markups of any number of documents. Areas are used for paths but never listed. */
export function buildRows(markups: Markup[], ctx: BuildContext): ScheduleRow[] {
  const byDoc = new Map<string, Markup[]>()
  for (const m of markups) {
    const l = byDoc.get(m.document_id)
    if (l) l.push(m); else byDoc.set(m.document_id, [m])
  }
  const rows: ScheduleRow[] = []
  for (const [docId, list] of byDoc) {
    const idx = buildAreaIndex(list.filter(isArea))
    const stacks = detectStacks(list)
    for (const m of list) {
      if (isArea(m) || isSheetArea(m)) continue
      const isDevice = m.type === 'device'
      if (!isDevice && !ctx.showAll) continue
      const set = m.symbol_set_id ? ctx.symbolSets.get(m.symbol_set_id) : undefined
      const dtype = m.device_type_id ? ctx.catalog?.types.get(m.device_type_id) : undefined
      const product = m.product_id ? ctx.catalog?.products.get(m.product_id) : undefined
      const path = areaPathIn(idx, m)
      const docName = m.document_name ?? ctx.docNames?.get(docId) ?? ''
      const meas = isDevice ? { value: '', num: null, unit: '' } : measurement(m, ctx.scaleFor?.(docId, m.page) ?? null)
      rows.push({
        id: m.id, markup: m, type: m.type, isDevice,
        tag: m.tag ?? '', setId: m.symbol_set_id ?? '', setName: set?.name ?? '',
        typeId: m.device_type_id ?? '', typeName: dtype?.name ?? '', productId: m.product_id ?? '', productName: productLabel(product),
        status: m.status ?? '', statusLabel: statusLabel(m.status),
        areaPath: path, areaText: path.join(AREA_SEP),
        documentId: docId, documentName: docName, page: m.page,
        sheet: docName ? `${docName} · p${m.page}` : `p${m.page}`,
        placedBy: m.created_by_name ?? '', placedAt: m.created_at ?? '',
        editedBy: m.updated_by_name ?? '', editedAt: m.updated_at ?? '',
        photos: m.photo_count ?? ctx.photoCounts?.get(m.id) ?? 0,
        fields: m.fields ?? {},
        value: meas.value, valueNum: meas.num, unit: meas.unit,
        stackSize: stacks.byId.get(m.id)?.members.length ?? 1,
      })
    }
  }
  return rows
}

// ---- Columns ----

export interface ColumnDef {
  id: string
  label: string
  field?: FieldDef
  /** Editable inline: status select or a field input. */
  edit?: 'status' | 'field'
}

export const fieldColId = (key: string) => `f:${key}`
const COMMON_HARDWARE = HARDWARE_FIELDS.filter(f => ['manufacturer', 'model', 'serial'].includes(f.key))

/** List columns. With a symbol set filter: that set's fields; otherwise common hardware fields plus any IP field. */
export function listColumns(rows: ScheduleRow[], sets: Map<string, SymbolSet>, setFilter: string, showAll: boolean): ColumnDef[] {
  const cols: ColumnDef[] = [
    { id: 'tag', label: 'Tag' },
    { id: 'set', label: 'Type / Set' },
    { id: 'deviceType', label: 'Device type' },
    { id: 'product', label: 'Product' },
    { id: 'status', label: 'Status', edit: 'status' },
    { id: 'area', label: 'Area' },
    { id: 'sheet', label: 'Sheet' },
  ]
  if (showAll) cols.push({ id: 'value', label: 'Value / Text' })
  let fields: FieldDef[]
  if (setFilter && sets.get(setFilter)) fields = sets.get(setFilter)!.fields
  else {
    fields = [...COMMON_HARDWARE]
    const seen = new Set(fields.map(f => f.key))
    const used = new Set(rows.map(r => r.setId))
    for (const s of sets.values()) {
      if (!used.has(s.id)) continue
      for (const f of s.fields) if (f.type === 'ip' && !seen.has(f.key)) { seen.add(f.key); fields.push(f) }
    }
  }
  for (const f of fields) cols.push({ id: fieldColId(f.key), label: f.label, field: f, edit: 'field' })
  cols.push(
    { id: 'placedBy', label: 'Placed by' },
    { id: 'editedBy', label: 'Last edited by' },
    { id: 'updated', label: 'Updated' },
    { id: 'photos', label: 'Photos' },
  )
  return cols
}

export function fieldText(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

/** Display text of a cell. */
export function cellText(r: ScheduleRow, col: ColumnDef): string {
  switch (col.id) {
    case 'tag': return r.tag
    case 'set': return r.isDevice ? r.setName : r.type
    case 'deviceType': return r.typeName
    case 'product': return r.productName
    case 'status': return r.isDevice ? r.statusLabel : ''
    case 'area': return r.areaText
    case 'sheet': return r.sheet
    case 'value': return r.value
    case 'placedBy': return r.placedBy
    case 'editedBy': return r.editedBy
    case 'updated': return r.editedAt || r.placedAt
    case 'photos': return r.photos ? String(r.photos) : ''
    default: return col.field && r.isDevice ? fieldText(r.fields[col.field.key]) : ''
  }
}

// ---- Filter / sort ----

export interface RowFilter { search: string; setId: string; status: string; area: string }
export const NO_FILTER: RowFilter = { search: '', setId: '', status: '', area: '' }

/** Every area path present, plus each outer path (so "First Floor" also selects its rooms). */
export function areaOptions(rows: ScheduleRow[]): string[] {
  const out = new Set<string>()
  for (const r of rows) for (let i = 1; i <= r.areaPath.length; i++) out.add(r.areaPath.slice(0, i).join(AREA_SEP))
  return [...out].sort(naturalCompare)
}

export function filterRows(rows: ScheduleRow[], f: RowFilter): ScheduleRow[] {
  const q = f.search.trim().toLowerCase()
  return rows.filter(r => {
    if (f.setId && r.setId !== f.setId) return false
    if (f.status && r.status !== f.status) return false
    if (f.area && r.areaText !== f.area && !r.areaText.startsWith(f.area + AREA_SEP)) return false
    if (!q) return true
    const hay = [r.tag, r.setName, r.typeName, r.productName, r.areaText, r.value, r.sheet, r.statusLabel, ...Object.values(r.fields).map(fieldText)]
    return hay.some(s => s.toLowerCase().includes(q))
  })
}

export function sortRows(rows: ScheduleRow[], columns: ColumnDef[], colId: string, dir: 'asc' | 'desc'): ScheduleRow[] {
  const col = columns.find(c => c.id === colId)
  if (!col) return rows
  const sign = dir === 'asc' ? 1 : -1
  const cmp = (a: ScheduleRow, b: ScheduleRow) => {
    if (col.id === 'photos') return a.photos - b.photos
    if (col.id === 'updated') { const x = cellText(a, col), y = cellText(b, col); return x < y ? -1 : x > y ? 1 : 0 }
    if (col.field?.type === 'number') {
      const x = parseFloat(cellText(a, col)), y = parseFloat(cellText(b, col))
      if (!isNaN(x) && !isNaN(y)) return x - y
    }
    return naturalCompare(cellText(a, col), cellText(b, col))
  }
  // Blanks always last; ties fall back to natural tag order
  return [...rows].sort((a, b) => {
    const ea = cellText(a, col) === '', eb = cellText(b, col) === ''
    if (ea !== eb) return ea ? 1 : -1
    return sign * cmp(a, b) || naturalCompare(a.tag, b.tag) || (a.id < b.id ? -1 : 1)
  })
}

// ---- Export tables ----

export type Cell = string | number | Date | null
export interface Table { name: string; header: string[]; data: Cell[][]; widths: number[] }

/** Sheet name: no []:*?/\ characters, at most 31 chars, unique among `taken` (case-insensitive). */
export function sheetName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '') || 'Sheet'
  base = base.slice(0, 31)
  let name = base, n = 2
  while (taken.has(name.toLowerCase())) {
    const suffix = ` (${n++})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  taken.add(name.toLowerCase())
  return name
}

const toDate = (s: string): Date | null => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d }

function exportFieldValue(v: unknown, def: FieldDef): Cell {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (def.type === 'number' && !isNaN(Number(v))) return Number(v)
  return String(v)
}

const NOTES: FieldDef = { key: 'notes', label: 'Notes', type: 'text' }

function deviceTable(name: string, rows: ScheduleRow[], fieldDefs: FieldDef[]): Table {
  const defs = [...fieldDefs]
  const seen = new Set(defs.map(f => f.key))
  for (const f of [...HARDWARE_FIELDS, NOTES]) if (!seen.has(f.key)) { seen.add(f.key); defs.push(f) }
  const header = ['Tag', 'Set', 'Device type', 'Product', 'Status', 'Area', 'Area 1', 'Area 2', 'Area 3', 'Document', 'Page',
    ...defs.map(f => f.label), 'Placed by', 'Placed at', 'Last edited by', 'Last edited at', 'Photos', 'id']
  const data: Cell[][] = rows.map(r => [
    r.tag, r.setName, r.typeName || null, r.productName || null, r.statusLabel, r.areaText,
    r.areaPath[0] ?? null, r.areaPath[1] ?? null, r.areaPath.length > 2 ? r.areaPath.slice(2).join(AREA_SEP) : null,
    r.documentName, r.page,
    ...defs.map(f => exportFieldValue(r.fields[f.key], f)),
    r.placedBy, toDate(r.placedAt), r.editedBy, toDate(r.editedAt), r.photos, r.id,
  ])
  return { name, header, data, widths: autoWidths(header, data) }
}

export function autoWidths(header: string[], data: Cell[][]): number[] {
  return header.map((h, i) => {
    if (h === 'id') return 10
    let w = h.length
    for (const row of data.slice(0, 200)) {
      const c = row[i]
      const len = c instanceof Date ? 16 : c === null ? 0 : String(c).length
      if (len > w) w = len
    }
    return Math.min(40, Math.max(8, w + 2))
  })
}

/** An "All devices" table, one table per symbol set that has devices, and a "Measurements" table. */
export function exportTables(allRows: ScheduleRow[], sets: SymbolSet[]): Table[] {
  const devices = allRows.filter(r => r.isDevice).sort((a, b) => naturalCompare(a.tag, b.tag) || (a.id < b.id ? -1 : 1))
  const taken = new Set<string>()
  const tables: Table[] = []
  const allName = sheetName('All devices', taken)
  const measName = sheetName('Measurements', taken)
  const unionFields: FieldDef[] = []
  const seen = new Set<string>()
  for (const s of sets) for (const f of s.fields) if (!seen.has(f.key)) { seen.add(f.key); unionFields.push(f) }
  tables.push(deviceTable(allName, devices, unionFields))
  const ordered = [...sets].sort((a, b) => a.sort - b.sort || naturalCompare(a.name, b.name))
  for (const s of ordered) {
    const rows = devices.filter(r => r.setId === s.id)
    if (rows.length) tables.push(deviceTable(sheetName(s.name, taken), rows, s.fields))
  }
  const meas = allRows.filter(r => MEASURE_TYPES.includes(r.type))
    .sort((a, b) => naturalCompare(a.documentName, b.documentName) || a.page - b.page || naturalCompare(a.type, b.type))
  const header = ['Type', 'Value', 'Amount', 'Unit', 'Document', 'Page', 'Area', 'Notes', 'Placed by']
  const data: Cell[][] = meas.map(r => [r.type, r.value, r.valueNum === null ? null : Math.round(r.valueNum * 100) / 100, r.unit || null,
    r.documentName, r.page, r.areaText, r.markup.text || null, r.placedBy])
  tables.push({ name: measName, header, data, widths: autoWidths(header, data) })
  return tables
}

export function exportFileName(projectName: string, now = new Date()): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Project'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${safe} - Device Schedule - ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.xlsx`
}
