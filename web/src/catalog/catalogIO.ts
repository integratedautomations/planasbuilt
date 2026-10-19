import type { SymbolSet } from '../markups/types'
import type { ImportSheet } from '../schedule/importDiff'
import type { Cell, Table } from '../schedule/rows'
import { autoWidths } from '../schedule/rows'
import type { CatalogData, Product } from './types'

/** Excel catalog: one "Products" sheet. Rows with an empty Set are standalone accessories. */
export const CATALOG_HEADER = ['Set', 'Type', 'Manufacturer', 'Model', 'Name', 'Spec URL', 'Unit cost', 'Labor hours', 'Accessories', 'Default fields']
const KNOWN = ['set', 'symbolset', 'type', 'devicetype', 'manufacturer', 'model', 'name', 'description', 'specurl', 'spec', 'speclink',
  'unitcost', 'cost', 'laborhours', 'labor', 'accessories', 'defaultfields']

const norm = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
export const productKey = (manufacturer: string, model: string) => `${manufacturer.trim().toLowerCase()}|${model.trim().toLowerCase()}`

/** "PAD100-B6 x 1; Rack kit x 2" for a product's accessories (model of referenced products, name of custom ones). */
export function accessoriesText(p: Product, byId: Map<string, Product>): string {
  return p.accessories.map(a => {
    const label = 'product_id' in a ? (() => { const r = byId.get(a.product_id); return r ? (r.model || r.name) : '' })() : a.name
    return label ? `${label} x ${a.qty}` : ''
  }).filter(Boolean).join('; ')
}

export function catalogTable(data: CatalogData, sets: SymbolSet[]): Table {
  const byId = new Map(data.products.map(p => [p.id, p]))
  const typeById = new Map(data.device_types.map(t => [t.id, t]))
  const setById = new Map(sets.map(s => [s.id, s]))
  const setOrder = new Map(sets.map((s, i) => [s.id, s.sort * 1000 + i]))
  const rowOf = (p: Product): Cell[] => {
    const t = p.device_type_id ? typeById.get(p.device_type_id) : undefined
    return [
      t ? setById.get(t.symbol_set_id)?.name ?? '' : '', t?.name ?? '', p.manufacturer, p.model, p.name, p.spec_url,
      p.unit_cost, p.labor_hours, accessoriesText(p, byId),
      Object.keys(p.default_fields).length ? JSON.stringify(p.default_fields) : null,
    ]
  }
  const devices = data.products.filter(p => p.device_type_id && typeById.has(p.device_type_id)).sort((a, b) => {
    const ta = typeById.get(a.device_type_id!)!, tb = typeById.get(b.device_type_id!)!
    return (setOrder.get(ta.symbol_set_id) ?? 0) - (setOrder.get(tb.symbol_set_id) ?? 0) || ta.sort - tb.sort
      || (a.manufacturer + a.model).localeCompare(b.manufacturer + b.model)
  })
  const accessories = data.products.filter(p => !p.device_type_id).sort((a, b) => (a.manufacturer + a.model).localeCompare(b.manufacturer + b.model))
  const rows = [...devices, ...accessories].map(rowOf)
  return { name: 'Products', header: CATALOG_HEADER, data: rows, widths: autoWidths(CATALOG_HEADER, rows) }
}

export interface ParsedProductRow {
  row: number
  set: string
  type: string
  manufacturer: string
  model: string
  name: string
  spec_url: string
  unit_cost: number | null
  labor_hours: number | null
  accessories: { ref: string; qty: number }[]
  default_fields: Record<string, string | number | boolean>
  /** Problems found while reading the row. */
  problems: string[]
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim())
const num = (v: unknown): number | null | 'bad' => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : 'bad'
}

/** "A x 2; B" becomes [{ref:'A', qty:2}, {ref:'B', qty:1}]. */
export function parseAccessories(s: string): { ref: string; qty: number }[] {
  return s.split(/[;\n]/).map(part => part.trim()).filter(Boolean).map(part => {
    const m = /^(.*?)\s*[x×*]\s*(\d+)$/i.exec(part)
    return m && m[1] ? { ref: m[1].trim(), qty: Math.max(1, parseInt(m[2], 10)) } : { ref: part, qty: 1 }
  })
}

/** Reads the Products sheet (or the first sheet that has Manufacturer and Model columns). */
export function parseCatalogSheets(sheets: ImportSheet[]): ParsedProductRow[] {
  const sheet = sheets.find(s => norm(s.name) === 'products') ?? sheets.find(s => {
    const h = (s.rows[0] ?? []).map(norm)
    return h.includes('manufacturer') && h.includes('model')
  })
  if (!sheet || sheet.rows.length < 2) return []
  const headers = sheet.rows[0].map(h => text(h))
  const idx = (...names: string[]) => headers.findIndex(h => names.includes(norm(h)))
  const col = {
    set: idx('set', 'symbolset'), type: idx('type', 'devicetype'), manufacturer: idx('manufacturer'), model: idx('model', 'model#'),
    name: idx('name', 'description'), spec: idx('specurl', 'spec', 'speclink'), cost: idx('unitcost', 'cost'),
    labor: idx('laborhours', 'labor'), acc: idx('accessories'), defaults: idx('defaultfields'),
  }
  const extra = headers.map((h, i) => ({ h, i })).filter(({ h }) => h && !KNOWN.includes(norm(h)))
  const out: ParsedProductRow[] = []
  sheet.rows.slice(1).forEach((r, n) => {
    const get = (i: number) => (i >= 0 ? r[i] : null)
    const problems: string[] = []
    const row: ParsedProductRow = {
      row: n + 2, set: text(get(col.set)), type: text(get(col.type)), manufacturer: text(get(col.manufacturer)), model: text(get(col.model)),
      name: text(get(col.name)), spec_url: text(get(col.spec)), unit_cost: null, labor_hours: null,
      accessories: parseAccessories(text(get(col.acc))), default_fields: {}, problems,
    }
    if (!row.manufacturer && !row.model && !row.name) return // blank line
    for (const [key, i] of [['unit_cost', col.cost], ['labor_hours', col.labor]] as const) {
      const v = num(get(i))
      if (v === 'bad') problems.push(`${key === 'unit_cost' ? 'Unit cost' : 'Labor hours'} is not a number`)
      else row[key] = v
    }
    const js = text(get(col.defaults))
    if (js) {
      try {
        const o = JSON.parse(js)
        if (o && typeof o === 'object' && !Array.isArray(o)) row.default_fields = o
        else problems.push('Default fields must be a JSON object')
      } catch { problems.push('Default fields is not valid JSON') }
    }
    for (const { h, i } of extra) {
      const v = r[i]
      if (v === null || v === undefined || v === '') continue
      const key = h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      row.default_fields[key] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v)
    }
    if (row.set && !row.type) problems.push('Type is required when Set is given')
    out.push(row)
  })
  return out
}

export type PlanAction = 'create' | 'update' | 'unchanged' | 'error'
export interface PlanItem {
  row: ParsedProductRow
  action: PlanAction
  /** Existing product matched by manufacturer + model. */
  existing?: Product
  /** Changed fields for updates: label, old, new text. */
  changes: { field: string; from: string; to: string }[]
  /** The device type will be created. */
  newType: boolean
  setId: string | null
  typeId: string | null
  errors: string[]
}
export interface CatalogPlan { items: PlanItem[]; counts: Record<PlanAction, number>; newTypes: number }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Preview diff of an import against the current catalog, matching products by manufacturer + model. */
export function planCatalogImport(rows: ParsedProductRow[], data: CatalogData, sets: SymbolSet[]): CatalogPlan {
  const byKey = new Map<string, Product>()
  for (const p of data.products) if (p.manufacturer || p.model) byKey.set(productKey(p.manufacturer, p.model), p)
  const byId = new Map(data.products.map(p => [p.id, p]))
  const setByName = new Map(sets.map(s => [s.name.trim().toLowerCase(), s]))
  const typeKey = (setId: string, name: string) => `${setId}|${name.trim().toLowerCase()}`
  const typeByKey = new Map(data.device_types.map(t => [typeKey(t.symbol_set_id, t.name), t]))
  const seenKeys = new Set<string>()
  const newTypeKeys = new Set<string>()
  const items: PlanItem[] = []
  for (const row of rows) {
    const errors = [...row.problems]
    let setId: string | null = null, typeId: string | null = null, newType = false
    if (row.set) {
      const s = setByName.get(row.set.toLowerCase())
      if (!s) errors.push(`Unknown set "${row.set}"`)
      else if (row.type) {
        setId = s.id
        const t = typeByKey.get(typeKey(s.id, row.type))
        if (t) typeId = t.id
        else { newType = true; newTypeKeys.add(typeKey(s.id, row.type)) }
      }
    }
    const key = productKey(row.manufacturer, row.model)
    if ((row.manufacturer || row.model) && seenKeys.has(key)) errors.push('Duplicate manufacturer + model in this file')
    seenKeys.add(key)
    const existing = row.manufacturer || row.model ? byKey.get(key) : undefined
    if (existing && typeId && existing.device_type_id && existing.device_type_id !== typeId) errors.push('Product already exists under another device type')
    if (errors.length) { items.push({ row, action: 'error', existing, changes: [], newType, setId, typeId, errors }); continue }
    const changes: PlanItem['changes'] = []
    if (existing) {
      const cmp = (field: string, from: string | number, to: string | number | null) => {
        if (to === null || String(from) === String(to)) return
        changes.push({ field, from: String(from), to: String(to) })
      }
      cmp('Name', existing.name, row.name || null)
      cmp('Spec URL', existing.spec_url, row.spec_url || null)
      cmp('Unit cost', existing.unit_cost, row.unit_cost)
      cmp('Labor hours', existing.labor_hours, row.labor_hours)
      const accNow = accessoriesText(existing, byId)
      const accNew = row.accessories.map(a => `${a.ref} x ${a.qty}`).join('; ')
      if (row.accessories.length && accNow.toLowerCase() !== accNew.toLowerCase()) changes.push({ field: 'Accessories', from: accNow, to: accNew })
      const merged = { ...existing.default_fields, ...row.default_fields }
      if (Object.keys(row.default_fields).length && !sameJson(merged, existing.default_fields))
        changes.push({ field: 'Default fields', from: JSON.stringify(existing.default_fields), to: JSON.stringify(merged) })
    }
    items.push({ row, action: !existing ? 'create' : changes.length ? 'update' : 'unchanged', existing, changes, newType, setId, typeId, errors })
  }
  const counts = { create: 0, update: 0, unchanged: 0, error: 0 } as Record<PlanAction, number>
  for (const i of items) counts[i.action]++
  return { items, counts, newTypes: newTypeKeys.size }
}

/**
 * Resolves accessory references (model, "Manufacturer Model" or name) to catalog products;
 * anything unmatched becomes a one-off named accessory.
 */
export function resolveAccessories(refs: { ref: string; qty: number }[], products: Product[], selfId?: string): Product['accessories'] {
  const lookup = new Map<string, Product>()
  for (const p of products) {
    if (p.id === selfId) continue
    for (const k of [p.model, `${p.manufacturer} ${p.model}`, p.name]) if (k.trim()) lookup.set(k.trim().toLowerCase(), p)
  }
  return refs.map(a => {
    const p = lookup.get(a.ref.trim().toLowerCase())
    return p ? { product_id: p.id, qty: a.qty } : { name: a.ref, qty: a.qty }
  })
}
