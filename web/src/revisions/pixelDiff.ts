import type { Rect } from '../markups/selection'

/** Anything shaped like ImageData (RGBA, 4 bytes per pixel). */
export interface ImageLike { width: number; height: number; data: ArrayLike<number> }

export interface PixelDiffOptions {
  /** Edge of one comparison cell, in pixels (default 8). */
  cell?: number
  /** Luminance difference (0-255) above which a pixel counts as changed (default 48). */
  threshold?: number
  /** A cell is changed when at least this many of its pixels changed (default 2). */
  minPixels?: number
  /** Changed cells this many cells apart (in either direction) join into one region (default 2). */
  gap?: number
  /** Drop regions smaller than this many cells (default 1). */
  minCells?: number
}

const luma = (d: ArrayLike<number>, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]

/**
 * Regions where two same-scale renderings of a page differ. Compares on a coarse grid of cells, then joins changed
 * cells into connected components (8-neighbour, bridging small gaps). Returns pixel rectangles of image `a`'s space.
 * Only the area both images cover is compared.
 */
export function diffPixels(a: ImageLike, b: ImageLike, opts: PixelDiffOptions = {}): Rect[] {
  const cell = Math.max(1, opts.cell ?? 8)
  const threshold = opts.threshold ?? 48
  const minPixels = opts.minPixels ?? 2
  const gap = Math.max(1, opts.gap ?? 2)
  const minCells = opts.minCells ?? 1
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height)
  if (w <= 0 || h <= 0) return []
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell)
  const changed = new Uint8Array(cols * rows)
  const counts = new Uint16Array(cols * rows)
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell)
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4, ib = (y * b.width + x) * 4
      if (Math.abs(luma(a.data, ia) - luma(b.data, ib)) > threshold) {
        const c = cy * cols + Math.floor(x / cell)
        if (++counts[c] >= minPixels) changed[c] = 1
      }
    }
  }
  const seen = new Uint8Array(cols * rows)
  const out: Rect[] = []
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue
    let x0 = cols, y0 = rows, x1 = -1, y1 = -1, n = 0
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const c = stack.pop()!
      const cx = c % cols, cy = (c - cx) / cols
      n++
      if (cx < x0) x0 = cx
      if (cx > x1) x1 = cx
      if (cy < y0) y0 = cy
      if (cy > y1) y1 = cy
      for (let dy = -gap; dy <= gap; dy++) {
        const ny = cy + dy
        if (ny < 0 || ny >= rows) continue
        for (let dx = -gap; dx <= gap; dx++) {
          const nx = cx + dx
          if (nx < 0 || nx >= cols) continue
          const nc = ny * cols + nx
          if (changed[nc] && !seen[nc]) { seen[nc] = 1; stack.push(nc) }
        }
      }
    }
    if (n >= minCells) out.push({ x: x0 * cell, y: y0 * cell, width: Math.min(w, (x1 + 1) * cell) - x0 * cell, height: Math.min(h, (y1 + 1) * cell) - y0 * cell })
  }
  return out.sort((p, q) => p.y - q.y || p.x - q.x)
}

/** Pixel rectangles to page points (the image was rendered at `scale` pixels per point). */
export const rectsToPage = (rects: Rect[], scale: number): Rect[] =>
  rects.map(r => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale }))

export type Tint = 'red' | 'cyan'

/**
 * Turns a rendered page into a one-colour ink image in place: white stays white, dark ink becomes pure red (or cyan).
 * Multiplying a red page with a cyan one leaves shared ink black, old-only ink red and new-only ink cyan.
 */
export function tintInk(data: Uint8ClampedArray | Uint8Array, tint: Tint) {
  for (let i = 0; i + 3 < data.length; i += 4) {
    const l = Math.round(luma(data, i))
    if (tint === 'red') { data[i] = 255; data[i + 1] = l; data[i + 2] = l } else { data[i] = l; data[i + 1] = 255; data[i + 2] = 255 }
    data[i + 3] = 255
  }
}
