import { api } from '../api'
import type { RevuMapping } from './revu'

interface Row { signature: string; action: RevuMapping['action']; symbol_set_id: string | null; device_type_id: string | null; product_id: string | null }

/** Saved Revu mappings of the organization, by signature. */
export async function loadRevuMappings(): Promise<Map<string, RevuMapping>> {
  const rows = await api<Row[]>('/revu-mappings')
  return new Map(rows.map(r => [r.signature, {
    signature: r.signature, action: r.action, symbol_set_id: r.symbol_set_id, device_type_id: r.device_type_id, product_id: r.product_id,
  }]))
}

export async function saveRevuMappings(list: RevuMapping[]): Promise<void> {
  await api('/revu-mappings', { method: 'PUT', body: JSON.stringify({ mappings: list }) })
}
