import type { View } from './usePanZoom'

export interface Box { x: number; y: number; width: number; height: number }

/** Union of boxes, or null when empty. */
export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x1 = Math.min(...boxes.map(b => b.x)), y1 = Math.min(...boxes.map(b => b.y))
  const x2 = Math.max(...boxes.map(b => b.x + b.width)), y2 = Math.max(...boxes.map(b => b.y + b.height))
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * Page-space point to centre on so `box` is brought into view, or null when its centre is already on screen
 * (inside the viewport minus `margin` px). Zoom is never changed.
 */
export function centerIfOffscreen(view: View, viewport: { width: number; height: number }, box: Box, margin = 24): { x: number; y: number } | null {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const sx = view.x + cx * view.zoom, sy = view.y + cy * view.zoom
  if (sx >= margin && sx <= viewport.width - margin && sy >= margin && sy <= viewport.height - margin) return null
  return { x: cx, y: cy }
}
