import { defaultProductId, fieldDefsFor, refillFields, tagPrefixFor } from '../catalog/catalog'
import type { Catalog } from '../catalog/catalog'
import { HARDWARE_FIELDS } from './types'
import type { BoxGeometry, Markup, SymbolSet } from './types'

/** What a device is replaced with. `typeId` null = the set's generic device; `productId` undefined = the type's default. */
export interface ReplaceTarget { setId: string; typeId: string | null; productId?: string | null }

const DEFAULT_FOV = { direction: -90, angle: 90, range: 150 }
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The device after swapping it for another set / type / product. Position, size, rotation, status, notes, layer,
 * style and photos (which hang off the markup id) are kept. Field values survive when the new device has a field
 * with the same key (hardware fields always do); manufacturer and model follow the new product. A tag numbered from
 * the old prefix is cleared so the server renumbers it from the new prefix; a prefix that did not change keeps its tag.
 */
export function replaceDevice(m: Markup, target: ReplaceTarget, symbolSets: Map<string, SymbolSet>, cat: Catalog): Markup {
  const oldSet = m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined
  const newSet = symbolSets.get(target.setId)
  const oldType = m.device_type_id ? cat.types.get(m.device_type_id) : undefined
  const newType = target.typeId ? cat.types.get(target.typeId) : undefined
  const productId = target.productId !== undefined ? target.productId : defaultProductId(cat, target.typeId)
  const product = productId ? cat.products.get(productId) : undefined

  const allowed = new Set([...fieldDefsFor(newSet, newType), ...HARDWARE_FIELDS].map(f => f.key))
  const kept = Object.fromEntries(Object.entries(m.fields ?? {}).filter(([k]) => allowed.has(k)))
  const fields = product ? refillFields(kept, product) : kept

  const oldPrefix = tagPrefixFor(oldSet, oldType), newPrefix = tagPrefixFor(newSet, newType)
  const numberedFromOld = !!m.tag && (oldPrefix ? new RegExp(`^${escapeRe(oldPrefix)}-\\d+$`).test(m.tag) : false)
  const tag = oldPrefix !== newPrefix && numberedFromOld ? '' : m.tag ?? ''

  let geometry = m.geometry
  if ('width' in geometry) {
    const g: BoxGeometry = { ...geometry }
    if (newSet?.has_fov) g.fov = g.fov ?? { ...DEFAULT_FOV }
    else delete g.fov
    geometry = g
  }
  return { ...m, geometry, symbol_set_id: target.setId, device_type_id: target.typeId, product_id: productId ?? null, tag, fields }
}

/** True when replacing would change anything (a different set, type or product). */
export function isSameDevice(m: Markup, target: ReplaceTarget): boolean {
  return m.symbol_set_id === target.setId && (m.device_type_id ?? null) === target.typeId
    && (target.productId === undefined || (m.product_id ?? null) === target.productId)
}
