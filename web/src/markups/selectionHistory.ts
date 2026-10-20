import { isSheetArea } from './areas'
import { markupBounds } from './selection'
import type { Markup } from './types'

export const HISTORY_MAX = 50

/** Adds a selection to the history (empty selections and an unchanged repeat are not recorded). */
export function pushSelection(history: string[][], ids: string[]): string[][] {
  if (!ids.length) return history
  const last = history[history.length - 1]
  if (last && last.length === ids.length && last.every((id, i) => id === ids[i])) return history
  return [...history, ids].slice(-HISTORY_MAX)
}

export interface AfterDeleteInput {
  /** Earlier selections, oldest first; the last entry is normally the selection being deleted. */
  history: string[][]
  deleted: Markup[]
  /** Everything still on the document (the deleted ones may or may not be in here). */
  remaining: Iterable<Markup>
}

const centre = (m: Markup) => { const b = markupBounds(m); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }

/**
 * What to select after deleting markups: the markups selected before the deleted ones (newest history entry that
 * still has living members on the same page), else the remaining markup nearest to the deleted ones on that page.
 */
export function selectAfterDelete({ history, deleted, remaining }: AfterDeleteInput): string[] {
  if (!deleted.length) return []
  const gone = new Set(deleted.map(m => m.id))
  const page = deleted[0].page
  const alive = new Map<string, Markup>()
  for (const m of remaining) if (!gone.has(m.id) && m.page === page && m.document_id === deleted[0].document_id) alive.set(m.id, m)
  for (let i = history.length - 1; i >= 0; i--) {
    const ids = history[i].filter(id => alive.has(id) && !isSheetArea(alive.get(id)!))
    if (ids.length) return ids
  }
  const cs = deleted.map(centre)
  const cx = cs.reduce((s, c) => s + c.x, 0) / cs.length, cy = cs.reduce((s, c) => s + c.y, 0) / cs.length
  let best: string | null = null, bestD = Infinity
  for (const m of alive.values()) {
    if (m.type === 'area') continue
    const c = centre(m)
    const d = Math.hypot(c.x - cx, c.y - cy)
    if (d < bestD) { bestD = d; best = m.id }
  }
  return best ? [best] : []
}
