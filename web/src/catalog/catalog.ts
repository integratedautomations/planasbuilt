import type { Mount } from '../markups/mount'
import { HARDWARE_FIELDS } from '../markups/types'
import type { FieldDef, Markup, SymbolSet } from '../markups/types'
import type { CatalogData, DeviceType, Product } from './types'

/** Lookup structure over the catalog; cheap to rebuild when the data changes. */
export interface Catalog {
  types: Map<string, DeviceType>
  products: Map<string, Product>
  typesBySet: Map<string, DeviceType[]>
  productsByType: Map<string, Product[]>
  /** False when unit costs and labor hours were withheld from this person. */
  canSeeCosts: boolean
}

export function buildCatalog(data: CatalogData): Catalog {
  const canSeeCosts = data.can_see_costs !== false
  // The server leaves costs out when this person may not see them; zero keeps the BOM maths finite (the UI hides the numbers).
  const list = canSeeCosts ? data.products : data.products.map(p => ({
    ...p, unit_cost: 0, labor_hours: 0,
    accessories: p.accessories.map(a => ('product_id' in a ? a : { ...a, unit_cost: 0, labor_hours: 0 })),
  }))
  data = { ...data, products: list }
  const types = new Map(data.device_types.map(t => [t.id, t]))
  const products = new Map(data.products.map(p => [p.id, p]))
  const typesBySet = new Map<string, DeviceType[]>()
  for (const t of [...data.device_types].sort((a, b) => a.sort - b.sort)) {
    const l = typesBySet.get(t.symbol_set_id)
    if (l) l.push(t); else typesBySet.set(t.symbol_set_id, [t])
  }
  const productsByType = new Map<string, Product[]>()
  for (const p of data.products) {
    if (!p.device_type_id) continue
    const l = productsByType.get(p.device_type_id)
    if (l) l.push(p); else productsByType.set(p.device_type_id, [p])
  }
  return { types, products, typesBySet, productsByType, canSeeCosts }
}

export const EMPTY_CATALOG: Catalog = buildCatalog({ device_types: [], products: [] })

/** "Manufacturer Model" or the product name, for lists and dropdowns. */
export function productLabel(p: Product | undefined): string {
  if (!p) return ''
  const mm = [p.manufacturer, p.model].filter(Boolean).join(' ')
  return mm || p.name
}

/** Dropdown text: model line plus the descriptive name when both exist. */
export function productOptionLabel(p: Product): string {
  const mm = [p.manufacturer, p.model].filter(Boolean).join(' ')
  return mm && p.name && p.name !== p.model ? `${mm} - ${p.name}` : mm || p.name
}

/** Active products a device type offers, sorted by label. */
export function productsFor(cat: Catalog, typeId: string | null | undefined): Product[] {
  if (!typeId) return []
  return (cat.productsByType.get(typeId) ?? []).filter(p => p.active && p.kind === 'device')
    .sort((a, b) => productLabel(a).localeCompare(productLabel(b)))
}

/** The type's default product when it is still active, else its first active one. */
export function defaultProductId(cat: Catalog, typeId: string | null | undefined): string | null {
  if (!typeId) return null
  const t = cat.types.get(typeId)
  const def = t?.default_product_id ? cat.products.get(t.default_product_id) : undefined
  if (def?.active) return def.id
  return productsFor(cat, typeId)[0]?.id ?? null
}

/** Icon for a device: its type's own icon, else the symbol set's. */
export function deviceIcon(m: Pick<Markup, 'device_type_id'>, set: SymbolSet | undefined, cat: Catalog): string | undefined {
  const t = m.device_type_id ? cat.types.get(m.device_type_id) : undefined
  return t?.icon || set?.icon || undefined
}

/** The default mount shape of a device's type (undefined = no type / ceiling). */
export function typeMountOf(m: Pick<Markup, 'device_type_id'>, cat: Catalog | undefined): Mount | undefined {
  return m.device_type_id ? cat?.types.get(m.device_type_id)?.mount : undefined
}

/** Field defs for a device: the set's fields, then its type's extra ones (a repeated key keeps the set's). */
export function fieldDefsFor(set: SymbolSet | undefined, type: DeviceType | undefined): FieldDef[] {
  const out = [...(set?.fields ?? [])]
  const seen = new Set(out.map(f => f.key))
  for (const f of type?.fields ?? []) if (!seen.has(f.key)) { seen.add(f.key); out.push(f) }
  return out
}

const HARDWARE_KEYS = new Set(HARDWARE_FIELDS.map(f => f.key))

/** Field values a newly placed device gets from its product: defaults plus manufacturer and model. */
export function productFields(p: Product | undefined): Record<string, string | number | boolean> {
  if (!p) return {}
  return {
    ...p.default_fields,
    ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}),
    ...(p.model ? { model: p.model } : {}),
  }
}

/**
 * Fields after switching a device to another product: manufacturer and model follow the product
 * (cleared when the new product has none); every other value, including serial numbers, is kept.
 */
export function refillFields(fields: Markup['fields'], p: Product | undefined): NonNullable<Markup['fields']> {
  const out = { ...(fields ?? {}) }
  if (!p) return out
  out.manufacturer = p.manufacturer
  out.model = p.model
  for (const [k, v] of Object.entries(p.default_fields)) if (!HARDWARE_KEYS.has(k) && (out[k] === undefined || out[k] === '')) out[k] = v
  return out
}

/** Tag prefix for a device: the type's own, else the set's. */
export const tagPrefixFor = (set: SymbolSet | undefined, type: DeviceType | undefined) => type?.tag_prefix || set?.tag_prefix || ''
