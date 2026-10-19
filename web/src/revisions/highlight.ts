import { markupBounds } from '../markups/selection'
import type { Markup } from '../markups/types'
import type { ChangeEntry } from './diff'

export const HIGHLIGHT_PREFIX = 'hl:'
const COLORS = { added: '#2f9e44', removed: '#e03131', changed: '#f08c00' }

/**
 * Dashed outline rectangles (as read-only rect markups) around changed markups on one page.
 * `side` 'old' draws where things used to be (removed in red, changed in orange); 'new' draws the newer state
 * (added in green, changed in orange); 'both' draws both, for the overlay view.
 */
export function highlightMarkups(entries: ChangeEntry[], page: number, side: 'old' | 'new' | 'both', documentId = ''): Markup[] {
  const out: Markup[] = []
  const rect = (id: string, m: Markup, color: string) => {
    const b = markupBounds(m)
    out.push({
      id: HIGHLIGHT_PREFIX + id, document_id: documentId, page, type: 'rect', text: '', layer_id: null,
      geometry: { x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8, rotation: 0 },
      style: { stroke: color, fill: '', strokeWidth: 2, opacity: 1, fontSize: 12, dash: true },
    })
  }
  for (const e of entries) {
    const onlyAdded = e.kinds.length === 1 && e.kinds[0] === 'added'
    const onlyRemoved = e.kinds.length === 1 && e.kinds[0] === 'removed'
    if ((side === 'old' || side === 'both') && e.before && e.before.page === page) rect(`${e.id}:old`, e.before, onlyRemoved ? COLORS.removed : COLORS.changed)
    if ((side === 'new' || side === 'both') && e.after && e.after.page === page) rect(`${e.id}:new`, e.after, onlyAdded ? COLORS.added : COLORS.changed)
  }
  return out
}
