import { uuid } from '../uuid'
import type { Markup, SymbolSet } from './types'

/** Field keys unique to one physical unit (ip, ip_address, nvr_ip, mac, serial_no), so a copy never inherits them — not "description" or "zip". */
export const UNIQUE_FIELD = /(^|[_\s-])(ip|mac|serial)([_\s-]|address|$)/i

/** Fields a copy keeps: everything except unique ones (key matches ip/mac/serial, or the set declares it an IP field). */
export function copyFields(fields: Markup['fields'], set?: SymbolSet): Markup['fields'] {
  if (!fields) return fields
  const ipKeys = new Set((set?.fields ?? []).filter(f => f.type === 'ip').map(f => f.key))
  return Object.fromEntries(Object.entries(fields).filter(([k]) => !UNIQUE_FIELD.test(k) && !ipKeys.has(k)))
}

export interface CopyOptions {
  page?: number
  dx?: number
  dy?: number
  set?: SymbolSet
}

/**
 * A copy of a markup ready to commit as new: fresh id, moved by dx/dy, and not attributed to the original's author.
 * Devices keep their symbol set, product and settings fields but get no tag (the server numbers it), lose
 * unique fields (IP/MAC/serial) and return to the default status. Photos live in attachments and are never copied.
 */
export function copyMarkup(m: Markup, opts: CopyOptions = {}): Markup {
  const { page = m.page, dx = 0, dy = 0, set } = opts
  const device = m.type === 'device'
  const copy: Markup = {
    ...structuredClone(m),
    id: uuid(), page,
    geometry: { ...structuredClone(m.geometry), x: m.geometry.x + dx, y: m.geometry.y + dy },
    created_by: undefined, created_by_name: undefined, created_at: undefined,
    updated_by: undefined, updated_by_name: undefined, updated_at: undefined, version: undefined,
    photo_count: undefined,
  }
  // A copied cable is not locked to the original devices (they stay where they are)
  if (copy.type === 'cable' && 'points' in copy.geometry) {
    delete copy.geometry.from; delete copy.geometry.to; delete copy.geometry.open
  }
  if (device) {
    copy.tag = ''
    copy.status = 'planned'
    copy.fields = copyFields(m.fields, set)
  }
  return copy
}
