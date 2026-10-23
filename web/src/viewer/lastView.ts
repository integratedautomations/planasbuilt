// Remembers where the user last looked in each plan page (per browser), for "open plans at the last view".
import type { View } from './usePanZoom'

const key = (documentId: string, page: number) => `planmark.lastview.${documentId}.${page}`

const ok = (v: unknown): v is View => {
  const r = v as View | null
  return !!r && [r.x, r.y, r.zoom].every(n => typeof n === 'number' && Number.isFinite(n)) && r.zoom > 0
}

export function loadLastView(documentId: string, page: number): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(documentId, page)) ?? 'null')
    return ok(v) ? { x: v.x, y: v.y, zoom: v.zoom } : null
  } catch { return null }
}

export function saveLastView(documentId: string, page: number, v: View) {
  try { if (ok(v)) localStorage.setItem(key(documentId, page), JSON.stringify({ x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1e4) / 1e4 })) } catch { /* storage unavailable */ }
}
