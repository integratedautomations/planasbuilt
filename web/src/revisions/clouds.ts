import type { Rect } from '../markups/selection'
import { rectsIntersect } from '../markups/selection'
import type { Markup } from '../markups/types'
import type { Change } from '../markups/useMarkups'

export const growRect = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 })

/** Merges rectangles that touch or sit within `gap` points of each other, repeatedly, until none do. */
export function mergeBoxes(rects: Rect[], gap = 24): Rect[] {
  let boxes = rects.map(r => ({ ...r }))
  let again = true
  while (again) {
    again = false
    const next: Rect[] = []
    for (const r of boxes) {
      const hit = next.findIndex(n => rectsIntersect(growRect(n, gap / 2), growRect(r, gap / 2)))
      if (hit < 0) { next.push(r); continue }
      const n = next[hit]
      const x0 = Math.min(n.x, r.x), y0 = Math.min(n.y, r.y)
      next[hit] = { x: x0, y: y0, width: Math.max(n.x + n.width, r.x + r.width) - x0, height: Math.max(n.y + n.height, r.y + r.height) - y0 }
      again = true
    }
    boxes = next
  }
  return boxes
}

export interface CloudInput { page: number; rect: Rect }

/**
 * Revision-cloud markups around changed areas: boxes on a page within `gap` points are merged, then padded.
 * Returned as one undoable change.
 */
export function cloudChange(input: CloudInput[], base: { documentId: string; layerId: string | null; newId: () => string; stroke?: string }, opts: { gap?: number; pad?: number } = {}): Change {
  const pad = opts.pad ?? 10
  const byPage = new Map<number, Rect[]>()
  for (const i of input) byPage.set(i.page, [...(byPage.get(i.page) ?? []), i.rect])
  const change: Change = []
  for (const [page, rects] of [...byPage].sort((a, b) => a[0] - b[0])) {
    for (const r of mergeBoxes(rects, opts.gap ?? 24)) {
      const g = growRect(r, pad)
      const cloud: Markup = {
        id: base.newId(), document_id: base.documentId, page, type: 'cloud', text: '', layer_id: base.layerId,
        geometry: { x: g.x, y: g.y, width: g.width, height: g.height, rotation: 0 },
        style: { stroke: base.stroke ?? '#e03131', fill: '', strokeWidth: 3, opacity: 1, fontSize: 18 },
      }
      change.push({ before: null, after: cloud })
    }
  }
  return change
}
