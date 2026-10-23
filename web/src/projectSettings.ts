// Project settings (Phase 8c) as the web app uses them: status workflow, required fields per status, tag rules,
// report sections, photo quality and the lock. Mirrors server/src/projectSettings.ts (the server is the authority).
import { HARDWARE_FIELDS, STATUSES } from './markups/types'
import type { FieldDef, Markup } from './markups/types'

export interface StatusDef { key: string; label: string; color: string }
export type TagFormat = 'org' | 'dash2' | 'plain' | 'dash3'
export const REPORT_SECTIONS = [
  { key: 'title', label: 'Title page' },
  { key: 'sheets', label: 'Plan sheets' },
  { key: 'devices', label: 'Device pages' },
  { key: 'photos', label: 'Photos' },
  { key: 'legend', label: 'Device summary' },
  { key: 'bom', label: 'Bill of materials' },
  { key: 'wiring', label: 'Wiring riser' },
] as const
export type ReportSectionKey = (typeof REPORT_SECTIONS)[number]['key']

export const TAG_FORMAT_LABELS: Record<TagFormat, string> = {
  org: 'Follow the company setting', dash2: 'CAM-01', plain: 'CAM1', dash3: 'CAM-001',
}

/** The part of the settings that organization defaults also carry. */
export interface ProjectRules {
  statuses: StatusDef[]
  required: Record<string, string[]>
  tag_prefixes: Record<string, string>
  tag_format: TagFormat
  tag_fill_gaps: boolean
  report: { sections: Record<ReportSectionKey, boolean> }
  photo_quality: number
}
export interface ProjectSettings extends ProjectRules {
  report: { sections: Record<ReportSectionKey, boolean>; has_logo: boolean }
  locked: boolean
}

export const DEFAULT_STATUS_LIST: StatusDef[] = [
  { key: 'planned', label: 'Planned', color: '#868e96' },
  { key: 'installed', label: 'Installed', color: '#1971c2' },
  { key: 'tested', label: 'Tested', color: '#2f9e44' },
  { key: 'punch', label: 'Punch', color: '#e03131' },
]

const allOn = (): Record<ReportSectionKey, boolean> =>
  ({ title: true, sheets: true, devices: true, photos: true, legend: true, bom: true, wiring: true })

export const DEFAULT_SETTINGS: ProjectSettings = {
  statuses: DEFAULT_STATUS_LIST, required: {}, tag_prefixes: {}, tag_format: 'org', tag_fill_gaps: false,
  report: { sections: allOn(), has_logo: false }, photo_quality: 0.8, locked: false,
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})

/** Accepts anything (an older server, a cached project) and returns complete settings. */
export function normalizeSettings(raw: unknown): ProjectSettings {
  const r = obj(raw)
  const statuses = Array.isArray(r.statuses)
    ? r.statuses.filter((s: any) => s && typeof s.key === 'string' && s.key && typeof s.label === 'string' && typeof s.color === 'string')
      .map((s: any) => ({ key: s.key as string, label: s.label as string, color: s.color as string }))
    : []
  const required: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(obj(r.required))) if (Array.isArray(v)) required[k] = v.filter(x => typeof x === 'string')
  const prefixes: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(r.tag_prefixes))) if (typeof v === 'string' && v) prefixes[k] = v
  const sections = allOn(), sec = obj(obj(r.report).sections)
  for (const { key } of REPORT_SECTIONS) if (typeof sec[key] === 'boolean') sections[key] = sec[key]
  const q = Number(r.photo_quality)
  return {
    statuses: statuses.length ? statuses : DEFAULT_STATUS_LIST,
    required, tag_prefixes: prefixes,
    tag_format: r.tag_format === 'dash2' || r.tag_format === 'plain' || r.tag_format === 'dash3' ? r.tag_format : 'org',
    tag_fill_gaps: r.tag_fill_gaps === true,
    report: { sections, has_logo: obj(r.report).has_logo === true },
    photo_quality: Number.isFinite(q) && q >= 0.3 && q <= 0.95 ? q : 0.8,
    locked: r.locked === true,
  }
}

let active: ProjectSettings = DEFAULT_SETTINGS

/**
 * Makes the project's settings the ones the whole app uses. The shared STATUSES list is updated in place, so every
 * place that shows or offers statuses (Properties, Devices page, markups list, legend, report) follows the project.
 */
export function applyProjectSettings(raw: unknown): ProjectSettings {
  active = normalizeSettings(raw)
  STATUSES.splice(0, STATUSES.length, ...active.statuses.map(s => ({ value: s.key, label: s.label, color: s.color })))
  return active
}
export const activeSettings = () => active

/** What the report may include: a section switched off for the project stays off. */
export function allowedSections(s: ProjectSettings = active) { return s.report.sections }

export interface Blocker { key: string; label: string }

/** Field definitions every device has plus its own: the keys a "required" rule can apply to. */
export const applicableDefs = (defs: FieldDef[]): FieldDef[] => {
  const seen = new Set<string>(), out: FieldDef[] = []
  for (const f of [...HARDWARE_FIELDS, ...defs]) if (!seen.has(f.key)) { seen.add(f.key); out.push(f) }
  return out
}

const filled = (v: unknown) => (typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' ? Number.isFinite(v) : v === true)

/**
 * What a device still needs before it may be given `status`. `photoCount` null = unknown, so the photo rule is left to
 * the server. Required fields the device does not have (not in its symbol set or type) are not asked for.
 */
export function missingForStatus(
  status: string, m: Pick<Markup, 'fields' | 'tag'>, defs: FieldDef[], photoCount: number | null, s: ProjectSettings = active,
): Blocker[] {
  const out: Blocker[] = []
  const known = new Map(applicableDefs(defs).map(f => [f.key, f.label]))
  for (const k of s.required[status] ?? []) {
    if (k === 'photo') { if (photoCount !== null && photoCount < 1) out.push({ key: k, label: 'a photo' }) }
    else if (k === 'tag') { if (!(m.tag ?? '').trim()) out.push({ key: k, label: 'a tag' }) }
    else if (known.has(k) && !filled(m.fields?.[k])) out.push({ key: k, label: known.get(k)! })
  }
  return out
}

/** "Installed needs IP address, Serial # and a photo". */
export function describeMissing(status: string, missing: Blocker[]): string {
  const name = STATUSES.find(x => x.value === status)?.label ?? status
  const list = missing.map(x => x.label)
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] ?? ''
  return `${name} needs ${joined}`
}

/** Who may change a locked project: admins only. */
export const lockedFor = (role: string | null | undefined, s: Pick<ProjectSettings, 'locked'> = active) => s.locked && role !== 'admin'

/** JPEG quality for photo compression, from the active project (0.8 by default). */
export const photoQuality = () => active.photo_quality

export interface StatusBlock { markup: Markup; missing: Blocker[] }

/**
 * Splits devices into those that may take `status` now and those still missing a required item. Devices already at that
 * status pass (the rule applies when the status changes). `photoCounts` maps a markup id to its photos when known.
 */
export function gateStatus(
  ms: Markup[], status: string, defsOf: (m: Markup) => FieldDef[], photoCounts?: Map<string, number>, s: ProjectSettings = active,
): { allowed: Markup[]; blocked: StatusBlock[] } {
  const allowed: Markup[] = [], blocked: StatusBlock[] = []
  for (const m of ms) {
    const missing = (m.status ?? '') === status ? [] : missingForStatus(status, m, defsOf(m), photoCounts?.get(m.id) ?? null, s)
    if (missing.length) blocked.push({ markup: m, missing }); else allowed.push(m)
  }
  return { allowed, blocked }
}

/** One sentence for a refused status change: what is missing and which devices were left alone. */
export function describeBlocked(status: string, blocked: StatusBlock[]): string {
  if (!blocked.length) return ''
  const keys = new Map<string, string>()
  for (const b of blocked) for (const x of b.missing) keys.set(x.key, x.label)
  const text = describeMissing(status, [...keys].map(([key, label]) => ({ key, label })))
  if (blocked.length === 1) return `${text}.`
  const tags = blocked.slice(0, 4).map(b => b.markup.tag || 'untagged').join(', ')
  return `${text}. ${blocked.length} devices were not changed (${tags}${blocked.length > 4 ? ', ...' : ''}).`
}
