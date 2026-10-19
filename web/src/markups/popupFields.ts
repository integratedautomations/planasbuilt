import { HARDWARE_FIELDS, STATUSES } from './types'
import type { DeviceType, Product } from '../catalog/types'
import { productLabel } from '../catalog/catalog'
import type { Markup, SymbolSet } from './types'

export interface PopupFieldDef { id: string; label: string }

/** Fields every markup can show in the popup, before the symbol sets' own fields. */
export const BASE_POPUP_FIELDS: PopupFieldDef[] = [
  { id: 'tag', label: 'Tag' },
  { id: 'type', label: 'Symbol set' },
  { id: 'deviceType', label: 'Device type' },
  { id: 'product', label: 'Product' },
  { id: 'status', label: 'Status' },
  { id: 'area', label: 'Area' },
  { id: 'placedBy', label: 'Placed by' },
  { id: 'editedBy', label: 'Last edited by' },
]

/** Everything the user can tick: base fields, hardware fields, then each set's fields (shared keys listed once). */
export function popupFieldOptions(sets: Iterable<SymbolSet>, types: Iterable<DeviceType> = []): PopupFieldDef[] {
  const out = [...BASE_POPUP_FIELDS]
  const seen = new Set<string>()
  const add = (key: string, label: string) => { if (!seen.has(key)) { seen.add(key); out.push({ id: `field:${key}`, label }) } }
  for (const f of HARDWARE_FIELDS) add(f.key, f.label)
  for (const s of sets) for (const f of s.fields) add(f.key, f.label)
  for (const t of types) for (const f of t.fields) add(f.key, f.label)
  return out
}

export interface PopupContext { set?: SymbolSet; deviceType?: DeviceType; product?: Product; areaPath?: string[] }

function fieldText(v: unknown): string {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

export function popupValue(id: string, m: Markup, ctx: PopupContext = {}): string {
  switch (id) {
    case 'tag': return m.tag || ''
    case 'type': return m.type === 'device' ? ctx.set?.name ?? '' : m.type
    case 'deviceType': return ctx.deviceType?.name ?? ''
    case 'product': return productLabel(ctx.product)
    case 'status': return STATUSES.find(s => s.value === m.status)?.label ?? ''
    case 'area': return ctx.areaPath?.join(' > ') ?? ''
    case 'placedBy': return m.created_by_name ?? ''
    case 'editedBy': return m.updated_by_name ?? ''
    default: return id.startsWith('field:') ? fieldText(m.fields?.[id.slice(6)]) : ''
  }
}

/** The popup's rows, in the order the user ticked them, skipping empty values. */
export function popupRows(m: Markup, selected: string[], options: PopupFieldDef[], ctx: PopupContext = {}) {
  const labels = new Map(options.map(o => [o.id, o.label]))
  return selected
    .filter(id => labels.has(id))
    .map(id => ({ id, label: labels.get(id)!, value: popupValue(id, m, ctx) }))
    .filter(r => r.value !== '')
}
