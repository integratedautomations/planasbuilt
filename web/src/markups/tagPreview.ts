// The tag the next placed device will get, for the cursor ghost. Mirrors the server's numbering (server/src/projectSettings.ts):
// same prefix rules, project tag format, org padding and fill-gaps setting, so the preview matches what placement assigns.
import type { TagFormat } from '../projectSettings'

const FORMAT_PADDING: Record<Exclude<TagFormat, 'org'>, number> = { dash2: 2, plain: 0, dash3: 3 }

/** The number in a tag made from `prefix` ("CAM-07" or "CAM7"), or null. */
export function tagNumber(tag: string, prefix: string): number | null {
  if (!tag.startsWith(prefix)) return null
  const rest = tag.slice(prefix.length).replace(/^-/, '')
  return /^\d{1,9}$/.test(rest) ? Number(rest) : null
}

/** Next number for a prefix given the numbers already used: the lowest free one, or one past the highest. */
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

/** The tag the next device with `prefix` receives, or '' when the prefix is empty. `tags` are the tags already in use. */
export function previewTag(prefix: string, tags: Iterable<string | undefined | null>, o: { format: TagFormat; fillGaps: boolean; orgPadding: number; /** Devices placed but not numbered yet (each takes the next number first). */ pending?: number }): string {
  if (!prefix) return ''
  const used: number[] = []
  for (const t of tags) {
    if (!t) continue
    const n = tagNumber(t, prefix)
    if (n !== null) used.push(n)
  }
  for (let i = 0; i < (o.pending ?? 0); i++) used.push(nextNumber(used, o.fillGaps))
  return formatTag(prefix, nextNumber(used, o.fillGaps), o.format, o.orgPadding)
}
