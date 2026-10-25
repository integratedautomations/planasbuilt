import { buildAreaIndex, areaIdOf, isArea } from './areas'
import type { AreaIndex } from './areas'
import { productLabel } from '../catalog/catalog'
import type { Catalog } from '../catalog/catalog'
import type { DeviceType, Product } from '../catalog/types'
import { resolveMount } from './mount'
import type { Mount } from './mount'
import type { Markup, SymbolSet } from './types'

/** A legend is a box markup; its settings live in `fields`. */
export type LegendGroupBy = 'type' | 'product' | 'type+product'
export type LegendScope = { kind: 'sheet'; page: number } | { kind: 'document' } | { kind: 'area'; areaId: string }
export type LegendColumn = 'icon' | 'name' | 'code' | 'manufacturer' | 'model' | 'description' | 'set' | 'count'
export type LegendSort = 'name' | 'code' | 'count-asc' | 'count-desc' | 'set' | 'manual'
export type LegendAlign = 'left' | 'center' | 'right'

export const LEGEND_COLUMNS: { key: LegendColumn; label: string }[] = [
  { key: 'icon', label: 'Icon' }, { key: 'name', label: 'Name' }, { key: 'code', label: 'Code / model' },
  { key: 'manufacturer', label: 'Manufacturer' }, { key: 'model', label: 'Model' }, { key: 'description', label: 'Description' },
  { key: 'set', label: 'Symbol set' }, { key: 'count', label: 'Count' },
]
export const LEGEND_SORTS: { key: LegendSort; label: string }[] = [
  { key: 'name', label: 'Name' }, { key: 'code', label: 'Code / model' }, { key: 'count-desc', label: 'Count (high to low)' },
  { key: 'count-asc', label: 'Count (low to high)' }, { key: 'set', label: 'Symbol set' }, { key: 'manual', label: 'Manual order' },
]
const COLUMN_KEYS = LEGEND_COLUMNS.map(c => c.key)
const isColumn = (c: string): c is LegendColumn => (COLUMN_KEYS as string[]).includes(c)

export interface LegendSettings {
  scope: string; groupBy: LegendGroupBy; columns: LegendColumn[]; title: string
  sort: LegendSort
  /** Row keys in the user's order (sort = 'manual'); rows not listed follow by name. */
  manual: string[]
  /** Sub-header per symbol set. */
  groupBySet: boolean
  /** List device types with no devices (count 0). */
  showZero: boolean
  /** Only these symbol sets (empty = all). */
  setIds: string[]
  /** Relative column widths (absent = default). */
  widths: Partial<Record<LegendColumn, number>>
  aligns: Partial<Record<LegendColumn, LegendAlign>>
}

export const DEFAULT_LEGEND: LegendSettings = {
  scope: 'sheet', groupBy: 'type', columns: ['icon', 'name', 'count'], title: 'Legend',
  sort: 'name', manual: [], groupBySet: false, showZero: false, setIds: [], widths: {}, aligns: {},
}

const pairs = (v: unknown): [string, string][] => typeof v === 'string' && v
  ? v.split(',').map(p => p.split(':') as [string, string]).filter(p => p.length === 2) : []
const list = (v: unknown): string[] => typeof v === 'string' && v ? v.split(',').filter(Boolean) : []

/** Reads a legend's settings out of its fields, falling back to defaults for anything missing. */
export function legendSettings(m: Pick<Markup, 'fields'>): LegendSettings {
  const f = m.fields ?? {}
  const groupBy = f.groupBy === 'product' || f.groupBy === 'type+product' ? f.groupBy : 'type'
  const cols = typeof f.columns === 'string' ? f.columns.split(',').filter(isColumn) : DEFAULT_LEGEND.columns
  const sort = LEGEND_SORTS.some(x => x.key === f.sort) ? f.sort as LegendSort : 'name'
  const widths: LegendSettings['widths'] = {}
  for (const [k, v] of pairs(f.widths)) { const n = Number(v); if (isColumn(k) && Number.isFinite(n) && n > 0) widths[k] = n }
  const aligns: LegendSettings['aligns'] = {}
  for (const [k, v] of pairs(f.aligns)) if (isColumn(k) && (v === 'left' || v === 'center' || v === 'right')) aligns[k] = v
  return {
    scope: typeof f.scope === 'string' && f.scope ? f.scope : 'sheet',
    groupBy,
    columns: cols.length ? cols : DEFAULT_LEGEND.columns,
    title: typeof f.title === 'string' ? f.title : DEFAULT_LEGEND.title,
    sort, manual: list(f.manual), groupBySet: f.groupBySet === '1' || f.groupBySet === true, showZero: f.showZero === '1' || f.showZero === true,
    setIds: list(f.setIds), widths, aligns,
  }
}

/** Fields that store the settings (lists as comma strings since fields hold primitives). */
export const legendFields = (s: LegendSettings): Record<string, string> => ({
  scope: s.scope, groupBy: s.groupBy, columns: s.columns.join(','), title: s.title,
  sort: s.sort, manual: s.manual.join(','), groupBySet: s.groupBySet ? '1' : '0', showZero: s.showZero ? '1' : '0', setIds: s.setIds.join(','),
  widths: Object.entries(s.widths).map(([k, v]) => `${k}:${v}`).join(','),
  aligns: Object.entries(s.aligns).map(([k, v]) => `${k}:${v}`).join(','),
})

/** Settings saved in a preset: where it counts (an area id is not portable) is limited to the sheet or document. */
export const presetFields = (s: LegendSettings): Record<string, string> =>
  legendFields({ ...s, scope: s.scope === 'document' ? 'document' : 'sheet' })

/** "sheet", "document" or "area:<id>" -> scope for the legend placed on `page`. */
export function scopeOf(setting: string, page: number): LegendScope {
  if (setting === 'document') return { kind: 'document' }
  if (setting.startsWith('area:')) return { kind: 'area', areaId: setting.slice(5) }
  return { kind: 'sheet', page }
}

export interface LegendRow {
  key: string
  name: string
  /** Product model (or the Revu code when the device has no product). */
  code: string
  manufacturer: string
  model: string
  description: string
  /** Icon image (data URL) of the type, else the symbol set. */
  icon: string
  /** Colour of the symbol set. */
  color: string
  setId: string
  setName: string
  setSort: number
  /** The type's default mount shape (a device's own override does not split rows). */
  mount?: Mount
  count: number
}

export interface LegendOptions {
  groupBy?: LegendGroupBy
  symbolSets?: Map<string, SymbolSet>
  /** Prebuilt area index (needed for the 'area' scope; built from `markups` when missing). */
  areaIndex?: AreaIndex
  /** Only these symbol sets (empty/absent = all). */
  setIds?: string[]
  /** Also list device types with no devices. */
  showZero?: boolean
}

/**
 * Rows of a count legend. Every device markup counts once (the members of a stack each count),
 * grouped by device type, product, or both. Rows are sorted by name (see `legendItems` for the legend's own sort).
 */
export function legendRows(markups: Iterable<Markup>, catalog: Catalog, scope: LegendScope, opts: LegendOptions = {}): LegendRow[] {
  const groupBy = opts.groupBy ?? 'type'
  const only = opts.setIds?.length ? new Set(opts.setIds) : null
  const all = [...markups]
  let idx = opts.areaIndex
  if (scope.kind === 'area' && !idx) idx = buildAreaIndex(all.filter(isArea))
  const inScope = (m: Markup) => {
    if (scope.kind === 'sheet') return m.page === scope.page
    if (scope.kind === 'area') {
      // the device belongs to the area or any area nested inside it
      let id = areaIdOf(idx!, m)
      for (let n = 0; id && n <= idx!.byId.size; n++) { if (id === scope.areaId) return true; id = idx!.parents.get(id) ?? null }
      return false
    }
    return true
  }
  const rows = new Map<string, LegendRow>()
  const blank = (key: string, name: string, setId: string, type: DeviceType | undefined, product: Product | undefined): LegendRow => {
    const set = opts.symbolSets?.get(setId)
    return {
      key, name, color: set?.color ?? '#868e96', icon: type?.icon || set?.icon || '', mount: resolveMount(type?.mount, null), count: 0,
      code: '', manufacturer: product?.manufacturer ?? '', model: product?.model ?? '', description: product?.name ?? '',
      setId, setName: set?.name ?? '', setSort: set?.sort ?? 0,
    }
  }
  for (const m of all) {
    if (m.type !== 'device' || !m.symbol_set_id || !inScope(m)) continue
    if (only && !only.has(m.symbol_set_id)) continue
    const type = m.device_type_id ? catalog.types.get(m.device_type_id) : undefined
    const product = m.product_id ? catalog.products.get(m.product_id) : undefined
    const set = opts.symbolSets?.get(m.symbol_set_id)
    const keyType = m.device_type_id ?? `set:${m.symbol_set_id}`
    const key = groupBy === 'type' ? keyType : groupBy === 'product' ? (m.product_id ?? keyType) : `${keyType}|${m.product_id ?? ''}`
    let row = rows.get(key)
    if (!row) {
      const byProduct = groupBy === 'product' && !!product
      const name = byProduct ? productLabel(product) : type?.name ?? set?.name ?? 'Device'
      const withProduct = groupBy === 'type+product' && !!product
      row = blank(key, withProduct ? `${name} - ${productLabel(product)}` : name, m.symbol_set_id, type, groupBy === 'type' ? undefined : product)
      rows.set(key, row)
    }
    row.count++
    // code column: the product model, else the model typed on the device, else the Revu code (first one found for the row)
    if (!row.code) {
      const typed = typeof m.fields?.model === 'string' ? m.fields.model : typeof m.fields?.revu_code === 'string' ? m.fields.revu_code : ''
      row.code = product?.model || typed
    }
    if (!row.model && typeof m.fields?.model === 'string') row.model = m.fields.model
    if (!row.manufacturer && typeof m.fields?.manufacturer === 'string') row.manufacturer = m.fields.manufacturer
  }
  if (opts.showZero && groupBy !== 'product') {
    for (const type of catalog.types.values()) {
      if (only && !only.has(type.symbol_set_id)) continue
      if (opts.symbolSets && !opts.symbolSets.has(type.symbol_set_id)) continue
      const key = groupBy === 'type' ? type.id : `${type.id}|`
      if (!rows.has(key)) rows.set(key, blank(key, type.name, type.symbol_set_id, type, undefined))
    }
  }
  return [...rows.values()].sort(byName)
}

const byName = (a: LegendRow, b: LegendRow) => a.name.localeCompare(b.name, undefined, { numeric: true })
const codeOf = (r: LegendRow) => r.code || r.model

/** Sorts rows the way a legend's `sort` setting asks. */
export function sortLegendRows(rows: LegendRow[], s: Pick<LegendSettings, 'sort' | 'manual'>): LegendRow[] {
  const out = [...rows]
  const cmp: Record<LegendSort, (a: LegendRow, b: LegendRow) => number> = {
    name: byName,
    code: (a, b) => (!codeOf(a) !== !codeOf(b) ? (codeOf(a) ? -1 : 1) : codeOf(a).localeCompare(codeOf(b), undefined, { numeric: true })) || byName(a, b),
    'count-asc': (a, b) => a.count - b.count || byName(a, b),
    'count-desc': (a, b) => b.count - a.count || byName(a, b),
    set: (a, b) => a.setSort - b.setSort || a.setName.localeCompare(b.setName) || byName(a, b),
    manual: (a, b) => {
      const ia = s.manual.indexOf(a.key), ib = s.manual.indexOf(b.key)
      return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || byName(a, b)
    },
  }
  return out.sort(cmp[s.sort])
}

/** What a legend draws, top to bottom: rows sorted by the legend's sort, with a sub-header per symbol set when grouped. */
export type LegendItem = { kind: 'header'; label: string; color: string } | { kind: 'row'; row: LegendRow }

export function legendItems(rows: LegendRow[], s: Pick<LegendSettings, 'sort' | 'manual' | 'groupBySet'>): LegendItem[] {
  if (!s.groupBySet) return sortLegendRows(rows, s).map(row => ({ kind: 'row' as const, row }))
  const groups = new Map<string, LegendRow[]>()
  for (const r of sortLegendRows(rows, { ...s, sort: 'set' })) {
    const g = groups.get(r.setId)
    if (g) g.push(r); else groups.set(r.setId, [r])
  }
  const out: LegendItem[] = []
  for (const g of groups.values()) {
    out.push({ kind: 'header', label: g[0].setName || 'Other', color: g[0].color })
    out.push(...sortLegendRows(g, s).map(row => ({ kind: 'row' as const, row })))
  }
  return out
}

const FLEX_WEIGHT: Record<LegendColumn, number> = { icon: 1, name: 3, code: 1.2, manufacturer: 1.6, model: 1.2, description: 3, set: 1.5, count: 1 }

/** Layout shared by the canvas and the PDF export: row height from the font size, column widths by weight. */
export function legendLayout(rows: LegendRow[], settings: LegendSettings, width: number, fontSize: number) {
  const pad = fontSize * 0.5
  const rowH = fontSize * 1.8
  const titleH = settings.title.trim() ? fontSize * 1.9 : 0
  const items = legendItems(rows, settings)
  const cols = settings.columns
  const inner = Math.max(40, width - pad * 2)
  const widths = Object.fromEntries(COLUMN_KEYS.map(k => [k, 0])) as Record<LegendColumn, number>
  // icon and count are fixed unless the user gave them a width
  let fixed = 0
  const flex: LegendColumn[] = []
  for (const c of cols) {
    if (c === 'icon' && !settings.widths.icon) { widths.icon = rowH; fixed += rowH }
    else if (c === 'count' && !settings.widths.count) { widths.count = fontSize * 3; fixed += widths.count }
    else flex.push(c)
  }
  const weight = (c: LegendColumn) => settings.widths[c] ?? FLEX_WEIGHT[c]
  const total = flex.reduce((t, c) => t + weight(c), 0) || 1
  const free = Math.max(20 * flex.length, inner - fixed)
  for (const c of flex) widths[c] = Math.max(20, free * weight(c) / total)
  const height = titleH + pad + Math.max(1, items.length) * rowH + pad
  return { pad, rowH, titleH, widths, height, items }
}

/** The text a row shows in a text column. */
export function legendCell(r: LegendRow, c: LegendColumn): string {
  switch (c) {
    case 'name': return r.name
    case 'code': return r.code
    case 'manufacturer': return r.manufacturer
    case 'model': return r.model
    case 'description': return r.description
    case 'set': return r.setName
    case 'count': return String(r.count)
    default: return ''
  }
}

/** Alignment of a column: the user's choice, else numbers right, text left. */
export const legendAlign = (s: LegendSettings, c: LegendColumn): LegendAlign => s.aligns[c] ?? (c === 'count' ? 'right' : 'left')

/** Moves a row key one step in the manual order (`rowKeys` is the current visible order). */
export function moveManual(rowKeys: string[], key: string, dir: -1 | 1): string[] {
  const i = rowKeys.indexOf(key), j = i + dir
  if (i < 0 || j < 0 || j >= rowKeys.length) return rowKeys
  const out = [...rowKeys]
  const t = out[i]; out[i] = out[j]; out[j] = t
  return out
}

/** Live rows for every legend markup in `markups`, keyed by legend id (counts run over all markups given). */
export function legendRowsFor(markups: Markup[], catalog: Catalog, symbolSets: Map<string, SymbolSet>): Map<string, LegendRow[]> {
  const out = new Map<string, LegendRow[]>()
  const legends = markups.filter(m => m.type === 'legend')
  if (!legends.length) return out
  const areaIndex = buildAreaIndex(markups.filter(isArea))
  for (const m of legends) {
    const s = legendSettings(m)
    out.set(m.id, legendRows(markups, catalog, scopeOf(s.scope, m.page), { groupBy: s.groupBy, symbolSets, areaIndex, setIds: s.setIds, showZero: s.showZero }))
  }
  return out
}
