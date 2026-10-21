// Built-in device icon library: the PlanAsBuilt icon set (145 devices, two options each), 24x24, stroke based, one colour
// (currentColor) so the category colour applies. The artwork lives in pabIcons.ts (generated, see
// web/scripts/gen-pab-icons.mjs); names, mounts and matchers in pabSpec.ts.
// An icon is stored on a device type / symbol set as a data URL (see iconDataUrl), so rendering needs nothing else.
import { PAB_ICONS } from './pabIcons'
import { PAB_CATEGORIES, PAB_CATEGORY_LABELS, deviceName } from './pabSpec'

/** The category label of the icon set: one per folder (Fire Alarm, Access Control, Cameras, ...). */
export type IconCategory = string

export interface IconDef {
  id: string
  name: string
  category: IconCategory
  keywords: string
  /** Inner SVG markup (shapes only). */
  body: string
}

export const ICON_CATEGORIES: IconCategory[] = PAB_CATEGORY_LABELS

const labelOf = new Map(PAB_CATEGORIES.map(c => [c.folder, c.label]))

/** Every icon option ("fire-smoke-a", "fire-smoke-b", ...). */
export const ICONS: IconDef[] = PAB_ICONS.flatMap(p => {
  const name = deviceName(p.slug), category = labelOf.get(p.folder) ?? p.folder
  const keywords = [name, ...p.keywords].join(' ').toLowerCase()
  return (['a', 'b'] as const).map(o => ({ id: `${p.slug}-${o}`, name: `${name} (${o.toUpperCase()})`, category, keywords, body: p[o] }))
})

const BY_ID = new Map(ICONS.map(i => [i.id, i]))
export const iconById = (id: string) => BY_ID.get(id)

/** The full SVG document for an icon, drawn in `color`. */
export function iconSvg(icon: IconDef, color = 'currentColor'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" color="${color}">${icon.body.replace(/currentColor/g, color)}</svg>`
}

/** Data URL to store on a device type / symbol set. White by default: devices draw it on their category-coloured circle. */
export function iconDataUrl(icon: IconDef, color = '#ffffff'): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg(icon, color))}`
}

/** True when every word occurs in the icon's name, keywords (from keywords.json), category or id. */
export const iconMatches = (words: string[], icon: Pick<IconDef, 'id' | 'name' | 'category' | 'keywords'>) =>
  words.every(w => `${icon.name} ${icon.keywords} ${icon.category} ${icon.id}`.toLowerCase().includes(w))

/** Icons matching a search (name, keywords, category) and an optional category filter. */
export function searchIcons(query: string, category: IconCategory | 'All' = 'All', icons: IconDef[] = ICONS): IconDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return icons.filter(i => (category === 'All' || i.category === category) && iconMatches(words, i))
}
