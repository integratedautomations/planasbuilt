import { api } from '../api'
import { legendFields, legendSettings, presetFields } from '../markups/legend'
import type { LegendSettings } from '../markups/legend'

/** Saved legend settings, shared by the company. `settings` is the legend's `fields` (see legendFields). */
export interface LegendPreset { id: string; name: string; set_id: string | null; settings: Record<string, string>; sort?: number }

export const PRESETS_CHANGED = 'legend-presets-changed'

/** What a preset stores: the legend's settings, with a scope that works anywhere. */
export const presetPayload = (name: string, s: LegendSettings, setId: string | null = null) =>
  ({ name: name.trim(), set_id: setId, settings: presetFields(s) })

/** The settings a legend placed from this preset starts with (the preset's set limits the legend to that set). */
export function settingsFromPreset(p: Pick<LegendPreset, 'settings' | 'set_id'>): LegendSettings {
  const s = legendSettings({ fields: p.settings })
  return p.set_id && !s.setIds.length ? { ...s, setIds: [p.set_id] } : s
}

/** Fields for a new legend markup placed from a preset. */
export const fieldsFromPreset = (p: Pick<LegendPreset, 'settings' | 'set_id'>) => legendFields(settingsFromPreset(p))

const notify = () => { try { window.dispatchEvent(new Event(PRESETS_CHANGED)) } catch { /* no window in tests */ } }

export async function saveLegendPreset(name: string, s: LegendSettings, setId: string | null = null): Promise<LegendPreset> {
  const row = await api<LegendPreset>('/legend-presets', { method: 'POST', body: JSON.stringify(presetPayload(name, s, setId)) })
  notify()
  return row
}
export async function updateLegendPreset(id: string, name: string, s: LegendSettings, setId: string | null): Promise<LegendPreset> {
  const row = await api<LegendPreset>(`/legend-presets/${id}`, { method: 'PUT', body: JSON.stringify(presetPayload(name, s, setId)) })
  notify()
  return row
}
export async function deleteLegendPreset(id: string) {
  await api(`/legend-presets/${id}`, { method: 'DELETE' })
  notify()
}
