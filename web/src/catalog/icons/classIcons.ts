// Device classes with two built-in icon options each: every device of the PlanAsBuilt icon set is one class, option A and B.
// Drawing rules of the set (see web/src/markups/mount.ts SAFE_AREA): 24x24, stroke 1.8, round caps, currentColor, NO
// container (the app draws the circle / wall D / square), all artwork inside x, y in [3, 21].
import { iconDataUrl, ICON_CATEGORIES, iconMatches } from './library'
import type { IconCategory, IconDef } from './library'
import { PAB_ICONS } from './pabIcons'
import { DEVICES, PAB_CATEGORIES, deviceName, matchDevice } from './pabSpec'
import type { PabCoverage, PabMount } from './pabSpec'

export interface IconClass {
  id: string
  name: string
  category: IconCategory
  /** Matches a lower-cased tool / device name. Earlier classes win. */
  match: RegExp
  /** Search words from keywords.json. */
  keywords: string
  mount: PabMount
  tagPrefix: string
  coverage?: PabCoverage
  a: IconDef
  b: IconDef
}

const labelOf = new Map(PAB_CATEGORIES.map(c => [c.folder, c.label]))
const iconBySlug = new Map(PAB_ICONS.map(p => [p.slug, p]))

const mk = (slug: string, o: 'a' | 'b', name: string, category: string, keywords: string, body: string): IconDef =>
  ({ id: `${slug}-${o}`, name: `${name} (${o.toUpperCase()})`, category, keywords, body })

/** One class per device, in matching priority order. */
export const ICON_CLASSES: IconClass[] = DEVICES.map(spec => {
  const p = iconBySlug.get(spec.slug)
  if (!p) throw new Error(`pabIcons.ts has no artwork for ${spec.slug}: re-run web/scripts/gen-pab-icons.mjs`)
  const name = deviceName(spec.slug), category = labelOf.get(p.folder) ?? p.folder
  const keywords = [name, ...p.keywords].join(' ').toLowerCase()
  return { id: spec.slug, name, category, match: spec.match, keywords, mount: spec.mount, tagPrefix: spec.prefix, coverage: spec.coverage,
    a: mk(spec.slug, 'a', name, category, keywords, p.a), b: mk(spec.slug, 'b', name, category, keywords, p.b) }
})

/** Every option, for searching alongside the main library. */
export const CLASS_ICONS: IconDef[] = ICON_CLASSES.flatMap(c => [c.a, c.b])

const BY_ID = new Map(ICON_CLASSES.map(c => [c.id, c]))

/** The class a Revu tool / device name belongs to, if it is recognised. */
export function classForName(name: string): IconClass | undefined {
  const spec = matchDevice(name)
  return spec ? BY_ID.get(spec.slug) : undefined
}

/** Classes matching a search (name, keywords, category) in one category or all, in category then name order. */
export function searchClasses(query: string, category: IconCategory | 'All' = 'All'): IconClass[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return ICON_CLASSES.filter(c => (category === 'All' || c.category === category) && iconMatches(words, { id: c.id, name: c.name, category: c.category, keywords: c.keywords }))
    .sort((x, y) => ICON_CATEGORIES.indexOf(x.category) - ICON_CATEGORIES.indexOf(y.category) || x.name.localeCompare(y.name))
}

/** Option A as a stored data URL, or undefined for an unrecognised name. */
export function autoIconFor(name: string, color = '#ffffff'): string | undefined {
  const c = classForName(name)
  return c ? iconDataUrl(c.a, color) : undefined
}
