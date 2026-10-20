import type { FieldDef } from '../markups/types'

export interface DeviceType {
  id: string
  symbol_set_id: string
  name: string
  icon: string
  /** null = use the symbol set's prefix. */
  tag_prefix: string | null
  /** Extra fields on top of the symbol set's own. */
  fields: FieldDef[]
  default_product_id: string | null
  /** Default coverage for new devices of this type (range in feet); null/absent = none. */
  coverage?: { on: boolean; angle: number; range_ft: number } | null
  sort: number
}

/** An accessory is either another product (any type) by id, or a one-off named item. */
export type Accessory =
  | { product_id: string; qty: number }
  | { name: string; unit_cost?: number; labor_hours?: number; qty: number }

export interface Product {
  id: string
  /** null for standalone accessory products. */
  device_type_id: string | null
  kind: 'device' | 'accessory'
  manufacturer: string
  model: string
  name: string
  spec_url: string
  unit_cost: number
  labor_hours: number
  default_fields: Record<string, string | number | boolean>
  accessories: Accessory[]
  active: boolean
}

export interface CatalogData { device_types: DeviceType[]; products: Product[] }
export const EMPTY_CATALOG_DATA: CatalogData = { device_types: [], products: [] }

export const accessoryProductId = (a: Accessory): string | null => ('product_id' in a ? a.product_id : null)
