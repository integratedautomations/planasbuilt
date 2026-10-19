import { HARDWARE_FIELDS, STATUSES } from './types'
import type { FieldDef } from './types'

export interface HistoryUser { id: string; name: string; email: string }
export interface HistoryEvent {
  id: string | number
  at: string
  action: string
  changes?: Record<string, unknown> | null
  user: HistoryUser | null
}

/** Server timestamps may be SQL-style ("2026-10-19 12:00:00", UTC) or ISO. */
export function parseTime(s: string): number {
  const t = /^\d{4}-\d\d-\d\d \d/.test(s) ? s.replace(' ', 'T') + 'Z' : s
  return Date.parse(t)
}

const DAY = 86_400_000

/** "just now", "5m ago", "2h ago", "3d ago" under 7 days; otherwise "Oct 19" (with the year when not this year). */
export function formatWhen(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = parseTime(iso)
  if (isNaN(t)) return ''
  const diff = Math.max(0, now - t)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fieldLabel(key: string, setFields: FieldDef[] = []): string {
  if (key === 'notes') return 'Notes'
  return [...setFields, ...HARDWARE_FIELDS].find(f => f.key === key)?.label ?? key
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

function show(v: unknown, kind: 'status' | 'plain'): string {
  if (kind === 'status') return STATUSES.find(s => s.value === v)?.label ?? String(v)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const s = String(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}

function describeChange(label: string, ch: unknown, kind: 'status' | 'plain'): string {
  const { from, to } = (ch && typeof ch === 'object' ? ch : {}) as { from?: unknown; to?: unknown }
  if (isEmpty(to)) return `cleared ${label}`
  if (isEmpty(from)) return `set ${label}: ${show(to, kind)}`
  return `changed ${label}: ${show(from, kind)} → ${show(to, kind)}`
}

/** Readable lines for one event, each starting with the actor's name. */
export function describeEvent(e: HistoryEvent, setFields: FieldDef[] = []): string[] {
  const who = e.user?.name || e.user?.email || 'Someone'
  const line = (s: string) => `${who} ${s}`
  switch (e.action) {
    case 'created': return [line('placed this')]
    case 'deleted': return [line('deleted this')]
    case 'restored': return [line('restored this')]
    case 'photo_added': return [line('added a photo')]
    case 'photo_annotated': return [line('annotated a photo')]
    case 'photo_deleted': return [line('deleted a photo')]
    case 'updated': {
      const out: string[] = []
      for (const [key, ch] of Object.entries(e.changes ?? {})) {
        if (key.startsWith('fields.')) out.push(line(describeChange(fieldLabel(key.slice(7), setFields), ch, 'plain')))
        else if (key === 'status') out.push(line(describeChange('Status', ch, 'status')))
        else if (key === 'tag') out.push(line(describeChange('Tag', ch, 'plain')))
        else if (key === 'text') out.push(line(describeChange('Text', ch, 'plain')))
        else if (key === 'layer_id') out.push(line('changed layer'))
        else if (key === 'symbol_set_id') out.push(line('changed device type'))
        else if (key === 'geometry' && ch) out.push(line('moved/resized'))
        else if (key === 'style' && ch) out.push(line('changed style'))
      }
      return out.length ? out : [line('edited this')]
    }
    default: return [line(e.action.replace(/_/g, ' '))]
  }
}
