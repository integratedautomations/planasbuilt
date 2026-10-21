// Validation of the built-in icon SVGs (the "pab" set). Pure string code, no DOM, so the generator script
// (web/scripts/gen-pab-icons.mjs, run by Node) and the tests share it.
//
// An icon is accepted only when it is a 24x24 stroke drawing made of a fixed list of shape elements with a fixed
// list of attributes. No text, script, href, style, transform, group, defs or url() references can get through.

export const ALLOWED_ELEMENTS = ['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'] as const

const ALLOWED_ATTRS = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity',
])
const PAINT = /^(none|currentColor)$/
const NUM = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i
const NUMERIC_ATTRS = new Set(['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity'])
const ROOT_ATTRS: Record<string, string> = {
  xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}

export const SAFE_MIN = 3
export const SAFE_MAX = 21

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface SvgCheck {
  ok: boolean
  errors: string[]
  /** Inner markup (the shapes) when ok. */
  body: string
  /** Geometric bounds of the artwork (stroke width ignored) when ok. */
  bounds: Box | null
  /** True when the artwork leaves the [3, 21] safe area. */
  outsideSafeArea: boolean
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(src: string, errors: string[], where: string): Record<string, string> {
  const out: Record<string, string> = {}
  const rest = src.replace(ATTR_RE, (_m, k: string, v1: string, v2: string) => { out[k] = v1 ?? v2; return ' ' }).trim()
  if (rest) errors.push(`${where}: cannot parse "${rest.slice(0, 30)}"`)
  return out
}

/** Validates one icon file's text. Returns the inner body and bounds when it passes. */
export function validateSvg(text: string): SvgCheck {
  const errors: string[] = []
  const fail = (): SvgCheck => ({ ok: false, errors, body: '', bounds: null, outsideSafeArea: false })
  const src = text.replace(/^﻿/, '').trim()
  const root = /^<svg\b([^>]*)>([\s\S]*)<\/svg>$/.exec(src)
  if (!root) { errors.push('not a single <svg> document'); return fail() }
  const rootAttrs = parseAttrs(root[1], errors, '<svg>')
  for (const [k, v] of Object.entries(rootAttrs)) {
    if (!(k in ROOT_ATTRS)) { if (!/^(width|height)$/.test(k) || !NUM.test(v)) errors.push(`<svg> attribute ${k} not allowed`) }
    else if (rootAttrs[k] !== ROOT_ATTRS[k]) errors.push(`<svg> ${k}="${v}" (expected ${ROOT_ATTRS[k]})`)
  }
  for (const k of Object.keys(ROOT_ATTRS)) if (!(k in rootAttrs) && k !== 'xmlns') errors.push(`<svg> is missing ${k}`)
  const inner = root[2].trim()
  if (!inner) errors.push('no shapes')
  const elems: { tag: string; attrs: Record<string, string> }[] = []
  let rest = inner
  const EL = /^<([A-Za-z][A-Za-z0-9]*)\b([^<>]*?)\/>\s*/
  while (rest) {
    const m = EL.exec(rest)
    if (!m) { errors.push(`unsupported markup near "${rest.slice(0, 40)}"`); break }
    const tag = m[1]
    if (!(ALLOWED_ELEMENTS as readonly string[]).includes(tag)) { errors.push(`element <${tag}> not allowed`); rest = rest.slice(m[0].length); continue }
    const attrs = parseAttrs(m[2], errors, `<${tag}>`)
    for (const [k, v] of Object.entries(attrs)) {
      if (!ALLOWED_ATTRS.has(k)) errors.push(`<${tag}> attribute ${k} not allowed`)
      else if ((k === 'fill' || k === 'stroke') && !PAINT.test(v)) errors.push(`<${tag}> ${k}="${v}" not allowed`)
      else if (k === 'stroke-linecap' && !/^(round|butt|square)$/.test(v)) errors.push(`<${tag}> stroke-linecap="${v}"`)
      else if (k === 'stroke-linejoin' && !/^(round|miter|bevel)$/.test(v)) errors.push(`<${tag}> stroke-linejoin="${v}"`)
      else if (NUMERIC_ATTRS.has(k) && !NUM.test(v)) errors.push(`<${tag}> ${k}="${v}" is not a number`)
      else if (k === 'd' && !/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$/.test(v)) errors.push('<path> d has unsupported characters')
      else if (k === 'points' && !/^[0-9eE.,\s+-]*$/.test(v)) errors.push(`<${tag}> points has unsupported characters`)
    }
    const need: Record<string, string[]> = { path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height'], line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'], ellipse: ['cx', 'cy', 'rx', 'ry'] }
    for (const k of need[tag]) if (!(k in attrs)) errors.push(`<${tag}> is missing ${k}`)
    elems.push({ tag, attrs })
    rest = rest.slice(m[0].length)
  }
  if (errors.length) return fail()
  const bounds = bodyBounds(inner)
  const outside = bounds.x0 < SAFE_MIN - 0.01 || bounds.y0 < SAFE_MIN - 0.01 || bounds.x1 > SAFE_MAX + 0.01 || bounds.y1 > SAFE_MAX + 0.01
  return { ok: true, errors, body: inner, bounds, outsideSafeArea: outside }
}

// ---- Geometry

const grow = (b: Box, x: number, y: number) => { b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y) }

/** Samples an SVG arc (endpoint form, SVG spec F.6.5) into the box. */
function arc(b: Box, x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number) {
  if (!rx || !ry) { grow(b, x2, y2); return }
  rx = Math.abs(rx); ry = Math.abs(ry)
  const p = (phi * Math.PI) / 180, c = Math.cos(p), s = Math.sin(p)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = c * dx + s * dy, y1p = -s * dx + c * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam) }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const k = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!fs && dth > 0) dth -= 2 * Math.PI
  if (fs && dth < 0) dth += 2 * Math.PI
  for (let i = 0; i <= 24; i++) {
    const t = th1 + (dth * i) / 24
    grow(b, c * rx * Math.cos(t) - s * ry * Math.sin(t) + cx, s * rx * Math.cos(t) + c * ry * Math.sin(t) + cy)
  }
}

/** Samples a quadratic (3 points) or cubic (4 points) Bezier into the box. */
function bezier(b: Box, pts: [number, number][]) {
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, u = 1 - t
    if (pts.length === 3) grow(b, u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0], u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1])
    else grow(b, u * u * u * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t * t * t * pts[3][0],
      u * u * u * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t * t * t * pts[3][1])
  }
}

function pathBounds(b: Box, d: string) {
  let x = 0, y = 0, sx = 0, sy = 0
  let lastC: [number, number] | null = null, lastQ: [number, number] | null = null
  for (const seg of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
    const cmd = seg[1]
    const n = (seg[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) ?? []).map(Number)
    const rel = cmd === cmd.toLowerCase(), U = cmd.toUpperCase()
    const per = ({ M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 } as Record<string, number>)[U]
    if (U === 'Z') { x = sx; y = sy; lastC = lastQ = null; continue }
    for (let i = 0; i + per <= n.length; i += per) {
      const a = n.slice(i, i + per)
      const ax = (v: number) => (rel ? x + v : v), ay = (v: number) => (rel ? y + v : v)
      let nc: [number, number] | null = null, nq: [number, number] | null = null
      if (U === 'H') x = ax(a[0])
      else if (U === 'V') y = ay(a[0])
      else if (U === 'A') { const nx = ax(a[5]), ny = ay(a[6]); arc(b, x, y, a[0], a[1], a[2], a[3], a[4], nx, ny); x = nx; y = ny }
      else if (U === 'C') { const p: [number, number][] = [[x, y], [ax(a[0]), ay(a[1])], [ax(a[2]), ay(a[3])], [ax(a[4]), ay(a[5])]]; bezier(b, p); nc = p[2]; x = p[3][0]; y = p[3][1] }
      else if (U === 'S') {
        const c1: [number, number] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y]
        const p: [number, number][] = [[x, y], c1, [ax(a[0]), ay(a[1])], [ax(a[2]), ay(a[3])]]; bezier(b, p); nc = p[2]; x = p[3][0]; y = p[3][1]
      } else if (U === 'Q') { const p: [number, number][] = [[x, y], [ax(a[0]), ay(a[1])], [ax(a[2]), ay(a[3])]]; bezier(b, p); nq = p[1]; x = p[2][0]; y = p[2][1] }
      else if (U === 'T') {
        const c1: [number, number] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y]
        const p: [number, number][] = [[x, y], c1, [ax(a[0]), ay(a[1])]]; bezier(b, p); nq = c1; x = p[2][0]; y = p[2][1]
      } else { x = ax(a[0]); y = ay(a[1]) }
      lastC = nc; lastQ = nq
      if ((U === 'M') && i === 0) { sx = x; sy = y }
      grow(b, x, y)
    }
  }
}

/** Geometric bounds (stroke ignored) of an icon body made of the allowed shape elements. */
export function bodyBounds(body: string): Box {
  const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const m of body.matchAll(/<([a-z]+)\b([^>]*)\/>/g)) {
    const attrs: Record<string, string> = {}
    for (const a of m[2].matchAll(ATTR_RE)) attrs[a[1]] = a[2] ?? a[3]
    const num = (k: string) => parseFloat(attrs[k] ?? '0') || 0
    const pts = () => (attrs.points ?? '').trim().split(/[\s,]+/).map(Number)
    switch (m[1]) {
      case 'circle': grow(b, num('cx') - num('r'), num('cy') - num('r')); grow(b, num('cx') + num('r'), num('cy') + num('r')); break
      case 'ellipse': grow(b, num('cx') - num('rx'), num('cy') - num('ry')); grow(b, num('cx') + num('rx'), num('cy') + num('ry')); break
      case 'rect': grow(b, num('x'), num('y')); grow(b, num('x') + num('width'), num('y') + num('height')); break
      case 'line': grow(b, num('x1'), num('y1')); grow(b, num('x2'), num('y2')); break
      case 'polyline': case 'polygon': { const p = pts(); for (let i = 0; i + 1 < p.length; i += 2) grow(b, p[i], p[i + 1]); break }
      case 'path': pathBounds(b, attrs.d ?? ''); break
    }
  }
  return b
}
