// Loads the vector line segments of a PDF page for snapping: memory cache, then IndexedDB (Dexie kv), then extraction from
// the page's operator list in slices so large drawings never block the UI. The operator list is not kept.
import { AnnotationMode, OPS } from 'pdfjs-dist'
import type { PDFPageProxy } from '../pdf'
import { db } from '../offline/db'
import { extractLinesAsync } from './vectorLines'
import type { Matrix6 } from './vectorLines'

const VERSION = 1
const MEMORY_MAX = 6
const memory = new Map<string, Float32Array>()

const remember = (key: string, v: Float32Array) => {
  memory.delete(key)
  memory.set(key, v)
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string)
}

/**
 * Segments [x1, y1, x2, y2, ...] of the page's vector artwork in page space, cached under `key`
 * (use document id + revision + page number: a new revision is a new key). Null when `isCancelled` says stop.
 */
export async function loadPageLines(page: PDFPageProxy, key: string, isCancelled: () => boolean = () => false): Promise<Float32Array | null> {
  const mem = memory.get(key)
  if (mem) { remember(key, mem); return mem }
  const rowKey = `vlines:${VERSION}:${key}`
  try {
    const row = await db.kv.get(rowKey)
    const segs = row?.value?.segs
    if (segs instanceof Float32Array) { remember(key, segs); return segs }
  } catch { /* storage unavailable: extract again */ }
  if (isCancelled()) return null
  const list = await page.getOperatorList({ intent: 'display', annotationMode: AnnotationMode.DISABLE })
  const view = page.getViewport({ scale: 1 }).transform as Matrix6
  const segs = await extractLinesAsync(list, OPS as unknown as Record<string, number>, view, {}, undefined, isCancelled)
  if (!segs) return null
  remember(key, segs)
  try { await db.kv.put({ key: rowKey, value: { segs } }) } catch { /* not cached; fine */ }
  return segs
}
