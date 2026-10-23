// Line segments of a PDF page's vector artwork, in the page space markups use (pdf.js viewport at scale 1).
// Pure: it walks a pdf.js operator list, so it needs no pdf.js import (the caller passes the OPS table). See pageLines.ts
// for loading, caching and running it without blocking the UI.

/** pdf.js 6 packs every path into one constructPath op: args = [paintOp, [Float32Array of DrawOPS-coded numbers] | [null], minMax]. */
const DRAW_MOVE = 0, DRAW_LINE = 1, DRAW_CURVE = 2, DRAW_QUAD = 3, DRAW_CLOSE = 4

export type Matrix6 = [number, number, number, number, number, number]
export interface OperatorListLike { fnArray: ArrayLike<number>; argsArray: ArrayLike<any> }
/** The pdf.js OPS table (names to numbers); only the names used here are read. */
export type OpsTable = Record<string, number>

export interface LineOptions {
  /** Segments shorter than this (points) are dropped. */
  minLength?: number
  /** Most segments kept (the longest win). */
  cap?: number
  /** Near-collinear segments merge when closer than this across (points). */
  mergeOffset?: number
  /** ...and within this many degrees of the same direction. */
  mergeAngle?: number
  /** ...and when they touch or the gap along the line is at most this (points). */
  mergeGap?: number
  /** Stop collecting raw segments beyond this many numbers (guards against hatch-filled drawings). */
  rawLimit?: number
}

export const DEFAULT_LINE_OPTIONS: Required<LineOptions> = { minLength: 3, cap: 20000, mergeOffset: 0.5, mergeAngle: 0.02, mergeGap: 1.5, rawLimit: 6_000_000 }

/** a first, then b: the result maps a point through `a` and then `b`. */
export function multiply(a: Matrix6, b: Matrix6): Matrix6 {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0]
const isMatrix = (m: unknown): m is ArrayLike<number> => !!m && typeof (m as ArrayLike<number>).length === 'number' && (m as ArrayLike<number>).length >= 6 && typeof (m as ArrayLike<number>)[0] === 'number'
const toMatrix = (m: ArrayLike<number>): Matrix6 => [m[0], m[1], m[2], m[3], m[4], m[5]]

const OPS_ENTER = ['paintFormXObjectBegin']
const OPS_LEAVE = ['paintFormXObjectEnd']

/**
 * Walks the operator list collecting path segments as flat [x1, y1, x2, y2, ...] in page space. Yields every `sliceOps`
 * operators so a caller can hand the thread back; returns the raw segments (not yet merged or filtered).
 * `view` is the viewport transform (user space to page space); the CTM is tracked through save / restore / transform
 * and form XObjects. Strokes and fills both count; clip-only paths (endPath) do not.
 */
export function* walkOperatorList(list: OperatorListLike, ops: OpsTable, view: Matrix6, sliceOps = 4000, rawLimit = DEFAULT_LINE_OPTIONS.rawLimit): Generator<void, number[]> {
  const raw: number[] = []
  const stack: Matrix6[] = []
  let ctm: Matrix6 = IDENTITY
  const { save, restore, transform, constructPath, endPath } = ops
  const enter = OPS_ENTER.map(n => ops[n]).filter(n => n !== undefined)
  const leave = OPS_LEAVE.map(n => ops[n]).filter(n => n !== undefined)
  const n = list.fnArray.length
  for (let i = 0; i < n; i++) {
    if (i % sliceOps === 0 && i > 0) yield
    const fn = list.fnArray[i]
    if (fn === save) stack.push(ctm)
    else if (fn === restore) { const top = stack.pop(); if (top) ctm = top }
    else if (fn === transform) { const m = list.argsArray[i]; if (isMatrix(m)) ctm = multiply(toMatrix(m), ctm) }
    else if (enter.includes(fn)) {
      stack.push(ctm)
      const m = list.argsArray[i]?.[0]
      if (isMatrix(m)) ctm = multiply(toMatrix(m), ctm)
    } else if (leave.includes(fn)) { const top = stack.pop(); if (top) ctm = top }
    else if (fn === constructPath) {
      const args = list.argsArray[i]
      if (!args || args[0] === endPath) continue
      const buf = args[1]?.[0] as ArrayLike<number> | null | undefined
      if (!buf || !buf.length) continue
      pathSegments(buf, multiply(ctm, view), raw)
      if (raw.length > rawLimit) break
    }
  }
  return raw
}

function pathSegments(buf: ArrayLike<number>, m: Matrix6, out: number[]) {
  const [a, b, c, d, e, f] = m
  let sx = 0, sy = 0, cx = 0, cy = 0, open = false
  const tx = (x: number, y: number) => a * x + c * y + e
  const ty = (x: number, y: number) => b * x + d * y + f
  const seg = (x1: number, y1: number, x2: number, y2: number) => { if (x1 !== x2 || y1 !== y2) out.push(x1, y1, x2, y2) }
  const bez = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    // Flatten in page space: about one piece per 6 points of control polygon, between 2 and 8
    const len = Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const steps = Math.max(2, Math.min(8, Math.ceil(len / 6)))
    let px = cx, py = cy
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t
      const qx = u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3
      const qy = u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
      seg(px, py, qx, qy)
      px = qx; py = qy
    }
    cx = x3; cy = y3
  }
  for (let i = 0; i < buf.length;) {
    switch (buf[i++]) {
      case DRAW_MOVE: cx = sx = tx(buf[i], buf[i + 1]); cy = sy = ty(buf[i], buf[i + 1]); i += 2; open = true; break
      case DRAW_LINE: {
        const x = tx(buf[i], buf[i + 1]), y = ty(buf[i], buf[i + 1]); i += 2
        if (!open) { sx = cx = x; sy = cy = y; open = true; break }
        seg(cx, cy, x, y); cx = x; cy = y
        break
      }
      case DRAW_CURVE: {
        bez(tx(buf[i], buf[i + 1]), ty(buf[i], buf[i + 1]), tx(buf[i + 2], buf[i + 3]), ty(buf[i + 2], buf[i + 3]), tx(buf[i + 4], buf[i + 5]), ty(buf[i + 4], buf[i + 5]))
        i += 6
        break
      }
      case DRAW_QUAD: {
        // Quadratic to cubic: control points at 2/3 of the way from each end to the control
        const qx = tx(buf[i], buf[i + 1]), qy = ty(buf[i], buf[i + 1]), x = tx(buf[i + 2], buf[i + 3]), y = ty(buf[i + 2], buf[i + 3])
        bez(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y)
        i += 4
        break
      }
      case DRAW_CLOSE: seg(cx, cy, sx, sy); cx = sx; cy = sy; break
      default: return // unknown code: the rest cannot be parsed
    }
  }
}

/** Merges near-collinear touching segments, drops short ones and caps the count (longest kept). Returns [x1, y1, x2, y2, ...]. */
export function finalizeSegments(raw: ArrayLike<number>, options: LineOptions = {}): Float32Array {
  const o = { ...DEFAULT_LINE_OPTIONS, ...options }
  const binA = (o.mergeAngle * Math.PI) / 180
  const groups = new Map<string, { ang: number; d: number; spans: [number, number][] }>()
  const MIN_ANG = (-0.25 * Math.PI) / 180
  for (let i = 0; i + 3 < raw.length; i += 4) {
    const x1 = raw[i], y1 = raw[i + 1], x2 = raw[i + 2], y2 = raw[i + 3]
    if (!isFinite(x1 + y1 + x2 + y2)) continue
    let ang = Math.atan2(y2 - y1, x2 - x1)
    while (ang < MIN_ANG) ang += Math.PI // direction is irrelevant: [MIN_ANG, PI + MIN_ANG)
    while (ang >= Math.PI + MIN_ANG) ang -= Math.PI
    const cos = Math.cos(ang), sin = Math.sin(ang)
    const d = -sin * x1 + cos * y1
    const t1 = cos * x1 + sin * y1, t2 = cos * x2 + sin * y2
    const key = `${Math.round(ang / binA)}|${Math.round(d / o.mergeOffset)}`
    let g = groups.get(key)
    if (!g) { g = { ang, d, spans: [] }; groups.set(key, g) }
    g.spans.push(t1 < t2 ? [t1, t2] : [t2, t1])
  }
  const out: { len: number; v: [number, number, number, number] }[] = []
  for (const g of groups.values()) {
    g.spans.sort((p, q) => p[0] - q[0])
    const cos = Math.cos(g.ang), sin = Math.sin(g.ang)
    let [s, e] = g.spans[0]
    const emit = () => {
      const len = e - s
      if (len >= o.minLength) out.push({ len, v: [s * cos - g.d * sin, s * sin + g.d * cos, e * cos - g.d * sin, e * sin + g.d * cos] })
    }
    for (let k = 1; k < g.spans.length; k++) {
      const [a, b] = g.spans[k]
      if (a <= e + o.mergeGap) e = Math.max(e, b)
      else { emit(); s = a; e = b }
    }
    emit()
  }
  if (out.length > o.cap) out.sort((p, q) => q.len - p.len).length = o.cap
  const res = new Float32Array(out.length * 4)
  out.forEach((s, i) => res.set(s.v, i * 4))
  return res
}

/** Synchronous extraction (tests, small pages). */
export function extractLines(list: OperatorListLike, ops: OpsTable, view: Matrix6, options: LineOptions = {}): Float32Array {
  const o = { ...DEFAULT_LINE_OPTIONS, ...options }
  const it = walkOperatorList(list, ops, view, 1 << 30, o.rawLimit)
  let r = it.next()
  while (!r.done) r = it.next()
  return finalizeSegments(r.value, o)
}

/** Extraction that hands the thread back between slices of operators (`yieldFn` defaults to a macrotask). */
export async function extractLinesAsync(list: OperatorListLike, ops: OpsTable, view: Matrix6, options: LineOptions = {}, yieldFn: () => Promise<void> = () => new Promise(r => setTimeout(r, 0)), isCancelled: () => boolean = () => false): Promise<Float32Array | null> {
  const o = { ...DEFAULT_LINE_OPTIONS, ...options }
  const it = walkOperatorList(list, ops, view, 3000, o.rawLimit)
  let r = it.next()
  while (!r.done) {
    if (isCancelled()) return null
    await yieldFn()
    r = it.next()
  }
  await yieldFn()
  return isCancelled() ? null : finalizeSegments(r.value, o)
}
