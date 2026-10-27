/** Tiny helpers for writing PDF content streams. */
export type RGB = [number, number, number]

export const num = (v: number) => {
  const s = (Math.round(v * 1000) / 1000).toString()
  return s === '-0' ? '0' : s
}

export function hexToRgb(hex: string | undefined | null, fallback: RGB | null = null): RGB | null {
  let h = (hex ?? '').trim().replace('#', '')
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) return fallback
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
}

export function rgbToHex(c: number[]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  if (c.length === 1) return `#${h(c[0]).repeat(3)}`
  if (c.length === 4) return rgbToHex([(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])])
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`
}

/** Text the standard fonts can show: smart punctuation folded to ASCII, anything beyond Latin-1 becomes '?'. */
export function sanitizeText(s: string): string {
  let out = ''
  for (const ch of s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/›/g, '>')) {
    out += ch.charCodeAt(0) > 255 ? '?' : ch
  }
  return out
}

/** Hex string operand for Tj. */
export function hexText(s: string): string {
  let out = '<'
  for (const ch of sanitizeText(s)) out += ch.charCodeAt(0).toString(16).padStart(2, '0')
  return out + '>'
}

export type ExtGState = { CA?: number; ca?: number; BM?: string }

/** Accumulates operators plus the resources they need. */
export class Ops {
  out: string[] = []
  gstates: Record<string, ExtGState> = {}
  fonts = new Set<'Helv' | 'HelvB'>()
  images = new Set<string>()
  add(s: string) { this.out.push(s); return this }
  gs(name: string, g: ExtGState) { this.gstates[name] = g; return this.add(`/${name} gs`) }
  fill(c: RGB) { return this.add(`${num(c[0])} ${num(c[1])} ${num(c[2])} rg`) }
  stroke(c: RGB) { return this.add(`${num(c[0])} ${num(c[1])} ${num(c[2])} RG`) }
  width(w: number) { return this.add(`${num(w)} w`) }
  dash(d?: number[]) { return this.add(d?.length ? `[${d.map(num).join(' ')}] 0 d` : '[] 0 d') }
  cm(m: number[]) { return this.add(`${m.map(num).join(' ')} cm`) }
  move(x: number, y: number) { return this.add(`${num(x)} ${num(y)} m`) }
  line(x: number, y: number) { return this.add(`${num(x)} ${num(y)} l`) }
  curve(a: number, b: number, c: number, d: number, e: number, f: number) {
    return this.add(`${[a, b, c, d, e, f].map(num).join(' ')} c`)
  }
  rect(x: number, y: number, w: number, h: number) { return this.add(`${[x, y, w, h].map(num).join(' ')} re`) }
  poly(pts: number[], closed: boolean) {
    for (let i = 0; i + 1 < pts.length; i += 2) i === 0 ? this.move(pts[0], pts[1]) : this.line(pts[i], pts[i + 1])
    return closed ? this.add('h') : this
  }
  ellipse(cx: number, cy: number, rx: number, ry: number) {
    const k = 0.5522847498
    this.move(cx + rx, cy)
    this.curve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry)
    this.curve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy)
    this.curve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry)
    this.curve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy)
    return this.add('h')
  }
  roundRect(x: number, y: number, w: number, h: number, r: number) {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    const k = r * 0.5522847498
    this.move(x + r, y).line(x + w - r, y).curve(x + w - r + k, y, x + w, y + r - k, x + w, y + r)
    this.line(x + w, y + h - r).curve(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h)
    this.line(x + r, y + h).curve(x + r - k, y + h, x, y + h - r + k, x, y + h - r)
    this.line(x, y + r).curve(x, y + r - k, x + r - k, y, x + r, y)
    return this.add('h')
  }
  /** Paint the current path: 'B' fill+stroke, 'f', 'S' or 'n'. */
  paint(fill: boolean, stroke: boolean) { return this.add(fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n') }
  save() { return this.add('q') }
  restore() { return this.add('Q') }
  /** Text drawn in a y-down local frame (so it needs the flipped text matrix). */
  text(s: string, x: number, y: number, size: number, color: RGB, bold = false, halo = 0) {
    const f = bold ? 'HelvB' : 'Helv'
    this.fonts.add(f)
    const tm = `1 0 0 -1 ${num(x)} ${num(y)} Tm`
    const show = `${hexText(s)} Tj`
    // Halo first (stroke-only, white, round joins), then the coloured fill on top: explicit modes, never 2 Tr.
    if (halo > 0) {
      this.add('q').add('BT').add(`/${f} ${num(size)} Tf`).stroke([1, 1, 1]).width(halo).add('1 j 1 J').add('1 Tr').add(tm).add(show).add('ET').add('Q')
    }
    this.add('q').add('BT').add(`/${f} ${num(size)} Tf`).fill(color).add('0 Tr').add(tm).add(show).add('ET').add('Q')
    return this
  }
  image(name: string, x: number, y: number, w: number, h: number) {
    this.images.add(name)
    return this.add('q').add(`${[w, 0, 0, -h, x, y + h].map(num).join(' ')} cm`).add(`/${name} Do`).add('Q')
  }
  toString() { return this.out.join('\n') }
}

/** Greedy word wrap using a width function. Explicit newlines are kept. */
export function wrapText(text: string, size: number, maxWidth: number, width: (s: string, size: number) => number): string[] {
  const lines: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let cur = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word
      if (cur && width(next, size) > maxWidth) { lines.push(cur); cur = word } else cur = next
    }
    lines.push(cur)
  }
  return lines
}
