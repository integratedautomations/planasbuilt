// "Standard device library": one symbol set per category of the built-in icon set and a device type for each of its 145
// devices (icon, mount, tag prefix, coverage). Idempotent and additive: it only creates sets and types and fills in blanks
// on matching existing types. It never deletes, archives, renames, or overwrites a custom icon.
//
// planLibrary() is pure (existing rows in, actions out) so the preview and the tests share the exact logic of the install.
import type { Db } from './db.js'
import { STD_DEVICES, STD_SETS } from './standardLibraryData.js'
import type { StdDevice, StdSet } from './standardLibraryData.js'

export type Mount = 'ceiling' | 'wall' | 'square'
export interface Coverage { on: boolean; angle: number; range_ft: number }

export interface SetRow { id: string; name: string; archived: boolean }
export interface TypeRow {
  id: string; symbol_set_id: string; name: string; icon: string; tag_prefix: string | null
  coverage: Coverage | null; mount: string | null; archived: boolean
}

/** Other names an existing symbol set may have for the same category (compared lower case, letters and digits only). */
const SET_ALIASES: Record<string, string[]> = {
  fire: ['fire', 'fire alarm', 'fire alarms', 'fire detection'],
  access: ['access', 'access control'],
  camera: ['camera', 'cameras', 'video', 'cctv', 'video surveillance'],
  network: ['network', 'networking', 'data'],
  intrusion: ['intrusion', 'security', 'burglar alarm', 'intrusion detection'],
  intercom: ['intercom', 'intercoms'],
  nursecall: ['nurse call', 'nursecall'],
  paging: ['paging', 'paging audio', 'audio', 'av', 'audio visual'],
  automation: ['automation', 'home automation', 'building automation'],
  general: ['general', 'misc', 'miscellaneous'],
}
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// ---- Icons

/** The stored data URL of an icon body, identical to the web app's iconDataUrl(icon, '#ffffff'). */
export function stdIconUrl(body: string, color = '#ffffff'): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" color="${color}">${body.replace(/currentColor/g, color)}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const BUILTIN_RE = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"(?: width="24" height="24")? fill="none" stroke="([^"]+)" stroke-width="[\d.]+" stroke-linecap="round" stroke-linejoin="round"(?: color="[^"]+")?>([\s\S]*)<\/svg>$/

/**
 * If `icon` is a built-in icon (the format the app's icon picker and the first-run seed produce: a 24x24 stroke SVG in
 * one colour), its body with the colour put back to currentColor. null for anything else: uploaded images, empty, or
 * any SVG that was not produced by the app.
 */
export function builtinBody(icon: string): string | null {
  const m = /^data:image\/svg\+xml;utf8,(.*)$/s.exec(icon)
  if (!m) return null
  let svg: string
  try { svg = decodeURIComponent(m[1]) } catch { return null }
  const b = BUILTIN_RE.exec(svg)
  if (!b) return null
  const color = b[1]
  return color === 'currentColor' ? b[2] : b[2].split(`"${color}"`).join('"currentColor"')
}

const NEW_BODIES = new Set(STD_DEVICES.flatMap(d => [d.icon, d.iconB]))
/** True when `icon` is an icon of the new set (option A or B, in any colour). */
export const isStdIcon = (icon: string) => { const b = builtinBody(icon); return b !== null && NEW_BODIES.has(b) }

// ---- Matching

const MATCHERS = STD_DEVICES.map(d => ({ d, re: new RegExp(d.match) }))
const deviceBySlug = new Map(STD_DEVICES.map(d => [d.slug, d]))

/** The device of `folder` whose matcher recognises a type name (first match in priority order). */
export function matchStdDevice(name: string, folder: string): StdDevice | undefined {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim()
  return n ? MATCHERS.find(m => m.d.folder === folder && m.re.test(n))?.d : undefined
}

// ---- Plan

export interface PlanSetCreate { folder: string; name: string; color: string; tag_prefix: string; has_fov: boolean; icon: string }
export interface PlanTypeAdd { folder: string; setId: string | null; setName: string; slug: string; name: string; icon: string; tag_prefix: string; mount: Mount; coverage: Coverage | null }
export interface PlanTypeUpdate { id: string; setName: string; name: string; slug: string; changes: ('icon' | 'mount' | 'tag_prefix' | 'coverage')[]; set: { icon?: string; mount?: Mount; tag_prefix?: string; coverage?: Coverage } }
export interface LibraryPlan {
  setsToCreate: PlanSetCreate[]
  typesToAdd: PlanTypeAdd[]
  typesToUpdate: PlanTypeUpdate[]
  /** Existing types that already match their device completely. */
  unchanged: number
  /** Categories whose symbol set was removed (archived) by someone: left alone. */
  skippedSets: string[]
  /** Types removed (archived) by someone that match a device: left alone. */
  skippedTypes: string[]
  /** Existing types that were left alone: custom icon kept (counted per type, a type may also be updated for other fields). */
  customIconsKept: number
}

export interface LibrarySummary {
  setsCreated: number
  typesAdded: number
  typesUpdated: number
  unchanged: number
  customIconsKept: number
  skippedSets: string[]
  skippedTypes: string[]
  /** Names, for the preview. */
  newSets: string[]
  addedTypes: { set: string; name: string }[]
  updatedTypes: { set: string; name: string; changes: string[] }[]
}

export function summarize(p: LibraryPlan): LibrarySummary {
  return {
    setsCreated: p.setsToCreate.length, typesAdded: p.typesToAdd.length, typesUpdated: p.typesToUpdate.length, unchanged: p.unchanged,
    customIconsKept: p.customIconsKept, skippedSets: p.skippedSets, skippedTypes: p.skippedTypes,
    newSets: p.setsToCreate.map(s => s.name),
    addedTypes: p.typesToAdd.map(t => ({ set: t.setName, name: t.name })),
    updatedTypes: p.typesToUpdate.map(t => ({ set: t.setName, name: t.name, changes: t.changes })),
  }
}

const sameCoverage = (a: Coverage | null, b: Coverage | null) => JSON.stringify(a) === JSON.stringify(b)

/** What installing the library would do to a database holding these sets and types. */
export function planLibrary(sets: SetRow[], types: TypeRow[]): LibraryPlan {
  const plan: LibraryPlan = { setsToCreate: [], typesToAdd: [], typesToUpdate: [], unchanged: 0, skippedSets: [], skippedTypes: [], customIconsKept: 0 }
  for (const std of STD_SETS) {
    const aliases = new Set([key(std.name), ...(SET_ALIASES[std.folder] ?? [])])
    const mine = sets.filter(s => aliases.has(key(s.name)))
    // The exact name wins over an alias; live sets over removed ones.
    const live = mine.filter(s => !s.archived).sort((a, b) => Number(key(b.name) === key(std.name)) - Number(key(a.name) === key(std.name)))[0]
    if (!live && mine.length) { plan.skippedSets.push(std.name); continue }
    const devices = STD_DEVICES.filter(d => d.folder === std.folder)
    if (!live) {
      const icon = stdIconUrl(deviceBySlug.get(std.iconSlug)?.icon ?? devices[0].icon)
      plan.setsToCreate.push({ folder: std.folder, name: std.name, color: std.color, tag_prefix: std.tagPrefix, has_fov: std.hasFov, icon })
      for (const d of devices) plan.typesToAdd.push(addOf(std, null, d))
      continue
    }
    const existing = types.filter(t => t.symbol_set_id === live.id)
    const claimed = new Set<string>()
    const claimFor = new Map<string, TypeRow>()
    // 1. same name (any state), 2. the class matcher on the type's name
    for (const d of devices) {
      const t = existing.find(x => !claimed.has(x.id) && key(x.name) === key(d.name))
      if (t) { claimed.add(t.id); claimFor.set(d.slug, t) }
    }
    for (const d of devices) {
      if (claimFor.has(d.slug)) continue
      const t = existing.find(x => !claimed.has(x.id) && !x.archived && matchStdDevice(x.name, std.folder)?.slug === d.slug)
      if (t) { claimed.add(t.id); claimFor.set(d.slug, t) }
    }
    for (const d of devices) {
      const t = claimFor.get(d.slug)
      if (!t) { plan.typesToAdd.push(addOf(std, live, d)); continue }
      if (t.archived) { plan.skippedTypes.push(`${live.name} / ${t.name}`); continue }
      const set: PlanTypeUpdate['set'] = {}
      const changes: PlanTypeUpdate['changes'] = []
      const wantIcon = stdIconUrl(d.icon)
      if (!t.icon) { set.icon = wantIcon; changes.push('icon') }
      else if (isStdIcon(t.icon)) { /* already the new set (A or B): keep the choice */ }
      else if (builtinBody(t.icon) !== null) { set.icon = wantIcon; changes.push('icon') }
      else plan.customIconsKept++
      // 'ceiling' is also the column default, so it is the only mount value that is safe to replace
      if ((t.mount ?? 'ceiling') === 'ceiling' && d.mount !== 'ceiling') { set.mount = d.mount; changes.push('mount') }
      if (!t.tag_prefix) { set.tag_prefix = d.tagPrefix; changes.push('tag_prefix') }
      if (!t.coverage && d.coverage && !sameCoverage(t.coverage, d.coverage)) { set.coverage = d.coverage; changes.push('coverage') }
      if (changes.length) plan.typesToUpdate.push({ id: t.id, setName: live.name, name: t.name, slug: d.slug, changes, set })
      else plan.unchanged++
    }
  }
  return plan
}

function addOf(std: StdSet, live: SetRow | null, d: StdDevice): PlanTypeAdd {
  return { folder: std.folder, setId: live?.id ?? null, setName: live?.name ?? std.name, slug: d.slug, name: d.name, icon: stdIconUrl(d.icon), tag_prefix: d.tagPrefix, mount: d.mount, coverage: d.coverage }
}

// ---- Database

export async function loadPlanInput(q: Db['query']): Promise<{ sets: SetRow[]; types: TypeRow[] }> {
  const sets = await q<SetRow>('SELECT id, name, archived FROM symbol_sets ORDER BY sort, created_at')
  const types = await q<TypeRow>('SELECT id, symbol_set_id, name, icon, tag_prefix, coverage, mount, archived FROM device_types ORDER BY sort, created_at')
  return { sets, types }
}

export async function previewLibrary(db: Db): Promise<LibrarySummary> {
  const { sets, types } = await loadPlanInput(db.query.bind(db))
  return summarize(planLibrary(sets, types))
}

/** Applies the plan in one transaction. A second run finds nothing to do. */
export async function installLibrary(db: Db): Promise<LibrarySummary> {
  return db.transaction(async q => {
    const { sets, types } = await loadPlanInput(q)
    const plan = planLibrary(sets, types)
    const ids = new Map<string, string>() // folder -> id of the set created in this run
    for (const s of plan.setsToCreate) {
      const [row] = await q<{ id: string }>(
        `INSERT INTO symbol_sets (name, color, tag_prefix, icon, fields, has_fov, sort)
         VALUES ($1,$2,$3,$4,'[]',$5,(SELECT coalesce(max(sort),0)+1 FROM symbol_sets)) RETURNING id`,
        [s.name, s.color, s.tag_prefix, s.icon, s.has_fov])
      ids.set(s.folder, row.id)
    }
    for (const t of plan.typesToAdd) {
      const setId = t.setId ?? ids.get(t.folder)!
      await q(
        `INSERT INTO device_types (symbol_set_id, name, icon, tag_prefix, fields, coverage, mount, sort)
         VALUES ($1,$2,$3,$4,'[]',$5,$6,(SELECT coalesce(max(sort),0)+1 FROM device_types WHERE symbol_set_id = $1))`,
        [setId, t.name, t.icon, t.tag_prefix, t.coverage ? JSON.stringify(t.coverage) : null, t.mount])
    }
    for (const u of plan.typesToUpdate) {
      // Only the blanks the plan found are written; COALESCE keeps every other column as it is
      await q(
        `UPDATE device_types SET icon = coalesce($2, icon), mount = coalesce($3, mount), tag_prefix = coalesce($4, tag_prefix),
           coverage = coalesce($5::jsonb, coverage) WHERE id = $1`,
        [u.id, u.set.icon ?? null, u.set.mount ?? null, u.set.tag_prefix ?? null, u.set.coverage ? JSON.stringify(u.set.coverage) : null])
    }
    return summarize(plan)
  })
}
