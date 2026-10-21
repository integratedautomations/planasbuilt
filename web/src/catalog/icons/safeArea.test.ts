import { describe, expect, it } from 'vitest'
import { ICON_CLASSES, T } from './classIcons'
import { SAFE_AREA } from '../../markups/mount'

type Box = { x0: number; y0: number; x1: number; y1: number }
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

/** Geometric bounds (stroke ignored) of an icon body made of path, circle and rect elements. */
export function bodyBounds(body: string): Box {
  const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const m of body.matchAll(/<(path|circle|rect)\b([^>]*)\/>/g)) {
    const attr = (n: string) => { const a = new RegExp(`\\s${n}="([^"]*)"`).exec(m[2]); return a ? parseFloat(a[1]) : 0 }
    if (m[1] === 'circle') { const r = attr('r'); grow(b, attr('cx') - r, attr('cy') - r); grow(b, attr('cx') + r, attr('cy') + r) }
    else if (m[1] === 'rect') { grow(b, attr('x'), attr('y')); grow(b, attr('x') + attr('width'), attr('y') + attr('height')) }
    else {
      const d = /\sd="([^"]*)"/.exec(m[2])![1]
      let x = 0, y = 0, sx = 0, sy = 0
      for (const seg of d.matchAll(/([MmLlHhVvCcAaZz])([^MmLlHhVvCcAaZz]*)/g)) {
        const cmd = seg[1], n = (seg[2].match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number)
        const rel = cmd === cmd.toLowerCase(), U = cmd.toUpperCase()
        const per = { M: 2, L: 2, H: 1, V: 1, C: 6, A: 7, Z: 0 }[U]!
        if (U === 'Z') { x = sx; y = sy; continue }
        for (let i = 0; i < n.length; i += per) {
          const a = n.slice(i, i + per)
          if (U === 'H') x = rel ? x + a[0] : a[0]
          else if (U === 'V') y = rel ? y + a[0] : a[0]
          else if (U === 'A') { const nx = rel ? x + a[5] : a[5], ny = rel ? y + a[6] : a[6]; arc(b, x, y, a[0], a[1], a[2], a[3], a[4], nx, ny); x = nx; y = ny }
          else if (U === 'C') {
            for (let k = 0; k < 6; k += 2) grow(b, rel ? x + a[k] : a[k], rel ? y + a[k + 1] : a[k + 1])
            x = rel ? x + a[4] : a[4]; y = rel ? y + a[5] : a[5]
          } else { x = rel ? x + a[0] : a[0]; y = rel ? y + a[1] : a[1] }
          if (U === 'M' && i === 0) { sx = x; sy = y }
          grow(b, x, y)
        }
      }
    }
  }
  return b
}

describe('option A icons', () => {
  it('draw no outer container and stay inside the safe area', () => {
    const { min, max } = SAFE_AREA
    for (const c of ICON_CLASSES) {
      const b = bodyBounds(c.a.body)
      expect(b.x0, `${c.id} left`).toBeGreaterThanOrEqual(min - 0.01)
      expect(b.y0, `${c.id} top`).toBeGreaterThanOrEqual(min - 0.01)
      expect(b.x1, `${c.id} right`).toBeLessThanOrEqual(max + 0.01)
      expect(b.y1, `${c.id} bottom`).toBeLessThanOrEqual(max + 0.01)
    }
  })
})

describe('letter codes', () => {
  it('fit the safe area for 1, 2 and 3 letters, and ignore extras and non-letters', () => {
    for (const text of ['S', 'W', 'CO', 'MM', 'WAP', 'REX', 'QWM', 'GB']) {
      const b = bodyBounds(T(text))
      expect(b.x0, text).toBeGreaterThanOrEqual(SAFE_AREA.min)
      expect(b.x1, text).toBeLessThanOrEqual(SAFE_AREA.max)
      expect(b.y0, text).toBeGreaterThanOrEqual(SAFE_AREA.min)
      expect(b.y1, text).toBeLessThanOrEqual(SAFE_AREA.max)
      expect(Math.abs((b.x0 + b.x1) / 2 - 12), `${text} centred`).toBeLessThan(1.2)
    }
    expect((T('ABCD').match(/<path/g) ?? []).length).toBe(3)
    expect(T('a-1')).toBe(T('A'))
    expect(T('123')).toBe('')
    expect(T('WAP')).not.toBe(T('WA'))
  })
  it('draws every letter A-Z', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') expect(T(ch), ch).toMatch(/^<path d="M[^"]+"\/>$/)
  })
})
