// Per-project settings (Phase 8c): status workflow, required fields per status, tag rules, report sections and logo,
// photo compression and the project lock. Stored as one jsonb document in projects.settings; the same shape (minus the
// logo and the lock) is the organization's "defaults for new projects".

export interface StatusDef { key: string; label: string; color: string }

export const DEFAULT_STATUSES: StatusDef[] = [
  { key: 'planned', label: 'Planned', color: '#868e96' },
  { key: 'installed', label: 'Installed', color: '#1971c2' },
  { key: 'tested', label: 'Tested', color: '#2f9e44' },
  { key: 'punch', label: 'Punch', color: '#e03131' },
]

/** CAM-01 ('dash2'), CAM1 ('plain'), CAM-001 ('dash3'); 'org' follows the organization's digit setting. */
export const TAG_FORMATS = ['org', 'dash2', 'plain', 'dash3'] as const
export type TagFormat = (typeof TAG_FORMATS)[number]

export const REPORT_SECTIONS = ['title', 'sheets', 'devices', 'photos', 'legend', 'bom', 'wiring'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]

export interface ProjectSettings {
  statuses: StatusDef[]
  /** Status key -> what a device needs before it may be saved with that status: field keys, 'photo' or 'tag'. */
  required: Record<string, string[]>
  /** Symbol set id -> tag prefix used in this project instead of the set's own. */
  tag_prefixes: Record<string, string>
  tag_format: TagFormat
  /** true: a new tag takes the lowest free number; false: continues from the highest. */
  tag_fill_gaps: boolean
  report: { sections: Record<ReportSection, boolean>; logo_key: string; logo_type: string }
  /** JPEG quality (0.3 to 0.95) the phone uses when shrinking photos. */
  photo_quality: number
  /** Only project admins may change anything. */
  locked: boolean
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  statuses: DEFAULT_STATUSES,
  required: {},
  tag_prefixes: {},
  tag_format: 'org',
  tag_fill_gaps: false,
  report: { sections: { title: true, sheets: true, devices: true, photos: true, legend: true, bom: true, wiring: true }, logo_key: '', logo_type: '' },
  photo_quality: 0.8,
  locked: false,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUS_KEY = /^[a-z0-9][a-z0-9_-]{0,23}$/
const COLOR = /^#[0-9a-fA-F]{6}$/
const FIELD_KEY = /^[A-Za-z0-9_.-]{1,60}$/
const PREFIX = /^[A-Za-z0-9_]{1,12}$/
export const REQUIRABLE_EXTRAS = ['photo', 'tag'] as const

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})

/** The effective settings: stored values over defaults, anything malformed falling back. Never throws. */
export function readProjectSettings(raw: unknown): ProjectSettings {
  const r = obj(raw), D = DEFAULT_PROJECT_SETTINGS
  const statuses = Array.isArray(r.statuses)
    ? r.statuses.filter((s: any) => s && STATUS_KEY.test(String(s.key)) && String(s.label ?? '').trim() && COLOR.test(String(s.color)))
      .map((s: any) => ({ key: String(s.key), label: String(s.label).trim().slice(0, 30), color: String(s.color) }))
    : []
  const required: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(obj(r.required))) if (Array.isArray(v)) required[k] = v.filter(x => typeof x === 'string' && FIELD_KEY.test(x))
  const prefixes: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(r.tag_prefixes))) if (UUID.test(k) && typeof v === 'string' && PREFIX.test(v)) prefixes[k.toLowerCase()] = v
  const rep = obj(r.report), sec = obj(rep.sections)
  const sections = { ...D.report.sections }
  for (const k of REPORT_SECTIONS) if (typeof sec[k] === 'boolean') sections[k] = sec[k]
  const q = Number(r.photo_quality)
  return {
    statuses: statuses.length ? statuses : D.statuses,
    required,
    tag_prefixes: prefixes,
    tag_format: (TAG_FORMATS as readonly string[]).includes(r.tag_format) ? r.tag_format : D.tag_format,
    tag_fill_gaps: r.tag_fill_gaps === true,
    report: { sections, logo_key: typeof rep.logo_key === 'string' ? rep.logo_key : '', logo_type: typeof rep.logo_type === 'string' ? rep.logo_type : '' },
    photo_quality: Number.isFinite(q) && q >= 0.3 && q <= 0.95 ? q : D.photo_quality,
    locked: r.locked === true,
  }
}

export interface MergeContext {
  /** Status keys that markups in the project use right now (they cannot be removed). */
  statusesInUse?: Iterable<string>
  /** Known symbol set ids (a prefix for an unknown set is rejected); omit to skip the check. */
  setIds?: Iterable<string>
}

/** Validates a partial update against the stored settings. Returns the new settings or a message for the user. */
export function mergeProjectSettings(current: ProjectSettings, patch: unknown, ctx: MergeContext = {}): { value: ProjectSettings } | { error: string } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'settings must be an object' }
  const p = patch as Record<string, any>
  const next: ProjectSettings = { ...current, report: { ...current.report, sections: { ...current.report.sections } } }

  if ('statuses' in p) {
    if (!Array.isArray(p.statuses) || p.statuses.length < 1 || p.statuses.length > 12) return { error: 'Add between 1 and 12 statuses' }
    const seen = new Set<string>(), labels = new Set<string>(), out: StatusDef[] = []
    for (const s of p.statuses) {
      const key = String(s?.key ?? '').trim(), label = String(s?.label ?? '').trim(), color = String(s?.color ?? '')
      if (!STATUS_KEY.test(key)) return { error: `Status key "${key}" must be 1 to 24 lowercase letters, digits, - or _` }
      if (seen.has(key)) return { error: `Status key "${key}" is used twice` }
      if (!label || label.length > 30) return { error: 'Every status needs a name of up to 30 characters' }
      if (labels.has(label.toLowerCase())) return { error: `Two statuses are named "${label}"` }
      if (!COLOR.test(color)) return { error: `Status "${label}" needs a color like #1971c2` }
      seen.add(key); labels.add(label.toLowerCase()); out.push({ key, label, color })
    }
    const missing = [...new Set(ctx.statusesInUse ?? [])].filter(k => k && !seen.has(k))
    if (missing.length) return { error: `Cannot remove status${missing.length > 1 ? 'es' : ''} still used by devices: ${missing.join(', ')}. Change those devices first.` }
    next.statuses = out
  }

  if ('required' in p) {
    const req = obj(p.required), out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(req)) {
      if (!Array.isArray(v)) return { error: `Required fields for "${k}" must be a list` }
      const list = [...new Set(v.map(x => String(x)))]
      if (list.some(x => !FIELD_KEY.test(x))) return { error: `A required field name for "${k}" is not valid` }
      if (list.length) out[k] = list
    }
    next.required = out
  }
  // Required lists may only name statuses that exist.
  const keys = new Set(next.statuses.map(s => s.key))
  for (const k of Object.keys(next.required)) if (!keys.has(k)) delete next.required[k]

  if ('tag_prefixes' in p) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj(p.tag_prefixes))) {
      const id = k.toLowerCase(), val = String(v ?? '').trim()
      if (!val) continue // blank = use the set's own prefix
      if (!UUID.test(id)) return { error: 'Tag prefixes are set per symbol set' }
      if (!PREFIX.test(val)) return { error: `Tag prefix "${val}" must be 1 to 12 letters, digits or _` }
      if (ctx.setIds && ![...ctx.setIds].map(s => s.toLowerCase()).includes(id)) return { error: 'Unknown symbol set' }
      out[id] = val.toUpperCase()
    }
    next.tag_prefixes = out
  }
  if ('tag_format' in p) {
    if (!(TAG_FORMATS as readonly string[]).includes(p.tag_format)) return { error: 'Tag format must be CAM-01, CAM1 or CAM-001' }
    next.tag_format = p.tag_format
  }
  if ('tag_fill_gaps' in p) {
    if (typeof p.tag_fill_gaps !== 'boolean') return { error: 'tag_fill_gaps must be true or false' }
    next.tag_fill_gaps = p.tag_fill_gaps
  }
  if ('report' in p) {
    const sec = obj(obj(p.report).sections)
    for (const [k, v] of Object.entries(sec)) {
      if (!(REPORT_SECTIONS as readonly string[]).includes(k)) return { error: `Unknown report section "${k}"` }
      if (typeof v !== 'boolean') return { error: `Report section "${k}" must be on or off` }
      next.report.sections[k as ReportSection] = v
    }
  }
  if ('photo_quality' in p) {
    const q = Number(p.photo_quality)
    if (!(Number.isFinite(q) && q >= 0.3 && q <= 0.95)) return { error: 'Photo quality must be between 0.3 and 0.95' }
    next.photo_quality = Math.round(q * 100) / 100
  }
  if ('locked' in p) {
    if (typeof p.locked !== 'boolean') return { error: 'locked must be true or false' }
    next.locked = p.locked
  }
  return { value: next }
}

/** The part of a project's settings copied from (and into) the organization defaults: no logo, no lock. */
export function defaultsPart(s: ProjectSettings) {
  return {
    statuses: s.statuses, required: s.required, tag_prefixes: s.tag_prefixes, tag_format: s.tag_format, tag_fill_gaps: s.tag_fill_gaps,
    report: { sections: s.report.sections }, photo_quality: s.photo_quality,
  }
}

/** What the API shows: the stored document without the file key. */
export function publicProjectSettings(s: ProjectSettings) {
  const { logo_key, logo_type, ...report } = s.report
  return { ...s, report: { ...report, has_logo: !!logo_key, logo_type } }
}

// ---- Required fields

export interface RequiredCheck {
  status: string
  fields: Record<string, unknown> | null | undefined
  tag: string
  photoCount: number
  /** Field keys that exist on this device (hardware + its set and type). Required keys that do not apply are skipped. */
  applicable: Set<string>
}

const filled = (v: unknown) => (typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' ? Number.isFinite(v) : v === true)

/** Keys that are required for the status and still missing. */
export function missingRequired(s: Pick<ProjectSettings, 'required'>, c: RequiredCheck): string[] {
  const want = s.required[c.status] ?? []
  const out: string[] = []
  for (const k of want) {
    if (k === 'photo') { if (c.photoCount < 1) out.push(k) }
    else if (k === 'tag') { if (!c.tag.trim()) out.push(k) }
    else if (c.applicable.has(k) && !filled(c.fields?.[k])) out.push(k)
  }
  return out
}

// ---- Tags

export const FORMAT_PADDING: Record<Exclude<TagFormat, 'org'>, number> = { dash2: 2, plain: 0, dash3: 3 }

/** The number in a tag made from `prefix` ("CAM-07" or "CAM7"), or null. */
export function tagNumber(tag: string, prefix: string): number | null {
  if (!tag.startsWith(prefix)) return null
  const rest = tag.slice(prefix.length).replace(/^-/, '')
  return /^\d{1,9}$/.test(rest) ? Number(rest) : null
}

/** Next number for a prefix given the numbers already used. */
export function nextNumber(used: Iterable<number>, fillGaps: boolean): number {
  const set = new Set(used)
  if (fillGaps) { let n = 1; while (set.has(n)) n++; return n }
  let max = 0
  for (const n of set) if (n > max) max = n
  return max + 1
}

/** CAM-07, CAM7 or CAM-007. `orgPadding` is the organization's digit count, used by the 'org' format. */
export function formatTag(prefix: string, n: number, format: TagFormat, orgPadding: number): string {
  if (format === 'plain') return `${prefix}${n}`
  const pad = format === 'org' ? orgPadding : FORMAT_PADDING[format]
  return `${prefix}-${String(n).padStart(pad, '0')}`
}

/** The prefix of a typed tag: "CAM-07" -> "CAM"; with the plain format also "CAM7" -> "CAM". */
export const tagPrefixFromTag = (tag: string, format: TagFormat) => tag.replace(format === 'plain' ? /-?\d+$/ : /-\d+$/, '')
