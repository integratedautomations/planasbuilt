import type { SymbolSet } from '../markups/types'
import type { CatalogData, Product } from './types'

export const sets = [
  { id: 'fa', name: 'Fire Alarm', color: '#e03131', tag_prefix: 'FA', icon: '', fields: [], has_fov: false, sort: 1 },
  { id: 'cam', name: 'Cameras', color: '#1971c2', tag_prefix: 'CAM', icon: 'cam.png', fields: [{ key: 'ip', label: 'IP', type: 'ip' }], has_fov: true, sort: 0 },
] as SymbolSet[]

const p = (o: Partial<Product> & { id: string }): Product => ({
  device_type_id: null, kind: 'device', manufacturer: '', model: '', name: '', spec_url: '', unit_cost: 0, labor_hours: 0,
  default_fields: {}, accessories: [], active: true, ...o,
})

/** Shared test catalog: Fire Alarm > Smoke Detector > PAD100 (+ accessories), Cameras > IP Camera > M3216. */
export const data: CatalogData = {
  device_types: [
    { id: 'sd', symbol_set_id: 'fa', name: 'Smoke Detector', icon: 'sd.png', tag_prefix: 'SD', fields: [{ key: 'zone', label: 'Zone', type: 'text' }], default_product_id: 'pad', sort: 0 },
    { id: 'ipc', symbol_set_id: 'cam', name: 'IP Camera', icon: '', tag_prefix: null, fields: [], default_product_id: null, sort: 0 },
  ],
  products: [
    p({ id: 'pad', device_type_id: 'sd', manufacturer: 'Potter', model: 'PAD100', name: 'Photo smoke', unit_cost: 60, labor_hours: 0.5,
      default_fields: { device_type: 'Smoke' }, accessories: [{ product_id: 'base', qty: 1 }, { name: 'Label', unit_cost: 1, qty: 2 }] }),
    p({ id: 'base', kind: 'accessory', manufacturer: 'Potter', model: 'B6', name: 'Base', unit_cost: 8, labor_hours: 0.25 }),
    p({ id: 'cam1', device_type_id: 'ipc', manufacturer: 'Axis', model: 'M3216', name: 'Dome', unit_cost: 500, labor_hours: 1.5, accessories: [{ product_id: 'base', qty: 2 }] }),
    p({ id: 'old', device_type_id: 'ipc', manufacturer: 'Axis', model: 'OLD', active: false }),
  ],
}
