/**
 * Page-space <-> PDF user-space conversion.
 * Markups live in pdf.js viewport space at scale 1: origin top-left, y down, page rotation applied.
 * PDF annotations live in unrotated user space (origin = CropBox lower-left corner, y up).
 */
export interface PageBox {
  /** CropBox lower-left corner in user space. */
  llx: number
  lly: number
  /** CropBox size in user space (before /Rotate). */
  width: number
  height: number
  /** /Rotate, normalized to 0, 90, 180 or 270. */
  rotation: number
}

export const normRotation = (r: number) => ((Math.round(r / 90) * 90) % 360 + 360) % 360

/** Size of the page as displayed (swapped for 90/270). */
export function displaySize(b: PageBox) {
  return b.rotation === 90 || b.rotation === 270 ? { width: b.height, height: b.width } : { width: b.width, height: b.height }
}

/** Display point (markup space) to PDF user space. */
export function toPdf(b: PageBox, x: number, y: number): [number, number] {
  let u: number, v: number
  switch (b.rotation) {
    case 90: u = y; v = x; break
    case 180: u = b.width - x; v = y; break
    case 270: u = b.width - y; v = b.height - x; break
    default: u = x; v = b.height - y
  }
  return [b.llx + u, b.lly + v]
}

/** PDF user-space point to display (markup) space. */
export function fromPdf(b: PageBox, px: number, py: number): { x: number; y: number } {
  const u = px - b.llx, v = py - b.lly
  switch (b.rotation) {
    case 90: return { x: v, y: u }
    case 180: return { x: b.width - u, y: v }
    case 270: return { x: b.height - v, y: b.width - u }
    default: return { x: u, y: b.height - v }
  }
}

export type Matrix = [number, number, number, number, number, number]

/** Rotate (degrees, clockwise on screen) about the origin then translate: local markup space to display space. */
export function localToDisplay(x: number, y: number, rotationDeg: number) {
  const a = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(a), sin = Math.sin(a)
  return (lx: number, ly: number) => ({ x: x + lx * cos - ly * sin, y: y + lx * sin + ly * cos })
}

/** PDF matrix taking markup-local coordinates (y down) straight to user space. */
export function localMatrix(b: PageBox, x: number, y: number, rotationDeg: number): Matrix {
  const t = localToDisplay(x, y, rotationDeg)
  const p = (lx: number, ly: number) => { const d = t(lx, ly); return toPdf(b, d.x, d.y) }
  const o = p(0, 0), ex = p(1, 0), ey = p(0, 1)
  return [ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]]
}

export const applyMatrix = (m: Matrix, x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

export function boundsOf(points: [number, number][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return [x0, y0, x1, y1]
}
