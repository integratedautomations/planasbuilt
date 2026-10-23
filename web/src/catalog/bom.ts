import type { SymbolSet } from '../markups/types'
import { productLabel } from './catalog'
import type { Catalog } from './catalog'
import type { Product } from './types'

/** What the BOM needs to know about one placed device (a stacked device counts on its own). */
export interface BomDevice {
  setId: string
  typeId: string | null
  productId: string | null
  documentId: string
  areaPath: string[]
}

export type BomSection = 'devices' | 'accessories' | 'unassigned'

export interface BomLine {
  key: string
  section: BomSection
  productId: string | null
  manufacturer: string
  model: string
  name: string
  /** "Camera > IP Camera" style grouping hint. */
  group: string
  /** Total quantity: placed devices plus accessories. */
  qty: number
  /** Part of qty that comes from accessories of other products. */
  accessoryQty: number
  unitCost: number
  laborHours: number
  extCost: number
  extLabor: number
}

export interface Bom { lines: BomLine[]; totals: { qty: number; cost: number; labor: number } }

/** area = an area path as listed in the schedule ("First Floor > Lobby"); devices in it or in its sub-areas match. */
export interface BomFilter { documentId?: string; area?: string }

const AREA_SEP = ' > '

const MAX_DEPTH = 4
const round = (n: number) => Math.round(n * 1e6) / 1e6

/** Bill of materials: placed products, their accessories (qty x device count, merged by product), and unassigned devices. */
export function computeBom(devices: BomDevice[], cat: Catalog, sets: Map<string, SymbolSet>, filter: BomFilter = {}): Bom {
  const lines = new Map<string, BomLine>()
  const line = (key: string, init: () => Omit<BomLine, 'key' | 'qty' | 'accessoryQty' | 'extCost' | 'extLabor'>) => {
    let l = lines.get(key)
    if (!l) { l = { key, qty: 0, accessoryQty: 0, extCost: 0, extLabor: 0, ...init() }; lines.set(key, l) }
    return l
  }
  const groupOf = (p: Product) => {
    const t = p.device_type_id ? cat.types.get(p.device_type_id) : undefined
    const s = t ? sets.get(t.symbol_set_id) : undefined
    return [s?.name, t?.name].filter(Boolean).join(' > ') || 'Accessories'
  }
  const addProduct = (p: Product, qty: number, asAccessory: boolean, depth: number, seen: Set<string>) => {
    const l = line(`p:${p.id}`, () => ({
      section: asAccessory && p.kind === 'accessory' ? 'accessories' : 'devices', productId: p.id,
      manufacturer: p.manufacturer, model: p.model, name: p.name, group: groupOf(p),
      unitCost: p.unit_cost, laborHours: p.labor_hours,
    }))
    // a product that is placed directly AND used as an accessory belongs with the devices
    if (!asAccessory && l.section === 'accessories') l.section = 'devices'
    l.qty += qty
    if (asAccessory) l.accessoryQty += qty
    if (depth >= MAX_DEPTH || seen.has(p.id)) return
    const next = new Set(seen).add(p.id)
    for (const a of p.accessories) {
      if ('product_id' in a) {
        const ap = cat.products.get(a.product_id)
        if (ap) addProduct(ap, qty * a.qty, true, depth + 1, next)
      } else {
        const c = line(`c:${a.name.toLowerCase()}|${a.unit_cost ?? 0}|${a.labor_hours ?? 0}`, () => ({
          section: 'accessories', productId: null, manufacturer: '', model: '', name: a.name, group: 'Accessories',
          unitCost: a.unit_cost ?? 0, laborHours: a.labor_hours ?? 0,
        }))
        c.qty += qty * a.qty
        c.accessoryQty += qty * a.qty
      }
    }
  }

  for (const d of devices) {
    if (filter.documentId && d.documentId !== filter.documentId) continue
    if (filter.area) {
      const path = d.areaPath.join(AREA_SEP)
      if (path !== filter.area && !path.startsWith(filter.area + AREA_SEP)) continue
    }
    const p = d.productId ? cat.products.get(d.productId) : undefined
    if (p) { addProduct(p, 1, false, 0, new Set()); continue }
    const t = d.typeId ? cat.types.get(d.typeId) : undefined
    const label = t?.name ?? sets.get(d.setId)?.name ?? 'device'
    line(`u:${t?.id ?? ''}|${d.setId}`, () => ({
      section: 'unassigned', productId: null, manufacturer: '', model: '', name: `Unassigned ${label}`,
      group: [sets.get(d.setId)?.name, t?.name].filter(Boolean).join(' > '), unitCost: 0, laborHours: 0,
    })).qty += 1
  }

  const order: Record<BomSection, number> = { devices: 0, accessories: 1, unassigned: 2 }
  const out = [...lines.values()].map(l => ({ ...l, extCost: round(l.qty * l.unitCost), extLabor: round(l.qty * l.laborHours) }))
    .sort((a, b) => order[a.section] - order[b.section] || a.group.localeCompare(b.group)
      || (a.name || a.model).localeCompare(b.name || b.model, undefined, { numeric: true }) || productLabelOf(a).localeCompare(productLabelOf(b)))
  const totals = out.reduce((t, l) => ({ qty: t.qty + l.qty, cost: round(t.cost + l.extCost), labor: round(t.labor + l.extLabor) }), { qty: 0, cost: 0, labor: 0 })
  return { lines: out, totals }
}

function productLabelOf(l: BomLine) {
  return productLabel({ manufacturer: l.manufacturer, model: l.model, name: l.name } as Product)
}

export const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
export const hours = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US')

export const BOM_HEADER = ['Section', 'Group', 'Manufacturer', 'Model', 'Name', 'Qty', 'From accessories', 'Unit cost', 'Ext cost', 'Labor hrs', 'Ext labor hrs']

/** Header + rows (+ totals row) as plain cells, for Excel and PDF. */
export function bomTable(bom: Bom, costs = true): { header: string[]; rows: (string | number)[][]; totals: (string | number)[] } {
  const sec: Record<BomSection, string> = { devices: 'Devices', accessories: 'Accessories', unassigned: 'Unassigned' }
  // Without costs the four cost/labor columns (the last four) are left out entirely.
  const keep = <T extends string | number>(r: T[]) => (costs ? r : r.slice(0, 7))
  return {
    header: keep(BOM_HEADER),
    rows: bom.lines.map(l => keep<string | number>([sec[l.section], l.group, l.manufacturer, l.model, l.name, l.qty, l.accessoryQty, l.unitCost, l.extCost, l.laborHours, l.extLabor])),
    totals: keep<string | number>(['Total', '', '', '', '', bom.totals.qty, '', '', bom.totals.cost, '', bom.totals.labor]),
  }
}
