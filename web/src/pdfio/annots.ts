import { COVERAGE_OPACITY, hasCoverage, rangePx, sectorPoints } from '../markups/coverage'
import { cloudArcs } from '../markups/geometry'
import { iconRect, mountShape, outlineAt, resolveMount, wallFacing } from '../markups/mount'
import type { Mount } from '../markups/mount'
import { legendAlign, legendCell, legendLayout, legendSettings } from '../markups/legend'
import type { LegendRow } from '../markups/legend'
import { feetOf, formatArea, formatFeetInches, formatRadius, pathMidpoint, polygonCentroid, polygonPerimeter, sqftOf } from '../markups/measure'
import { HARDWARE_FIELDS, STATUSES } from '../markups/types'
import type { BoxGeometry, Markup, PathGeometry, SymbolSet } from '../markups/types'
import { applyMatrix, boundsOf, localMatrix, localToDisplay } from './coords'
import type { Matrix, PageBox } from './coords'
import { hexToRgb, Ops, wrapText } from './stream'
import type { ExtGState, RGB } from './stream'

export type AnnotSubtype = 'Square' | 'Circle' | 'Line' | 'PolyLine' | 'Polygon' | 'Ink' | 'FreeText' | 'Stamp'
type Rect4 = [number, number, number, number]
type P = [number, number]

export interface MeasureSpec {
  /** Scale text, e.g. "1 in = 8 ft". */
  ratio: string
  pointsPerFoot: number
}

/** Everything the writer needs for one annotation; pure data so it can be tested without a PDF. */
export interface AnnotSpec {
  markupId: string
  subtype: AnnotSubtype
  /** Annotation /Rect (covers everything the appearance draws). */
  rect: Rect4
  /** Exact shape bounds when /Rect is padded (written as /RD for Square, Circle and FreeText). */
  inner?: Rect4
  subject: string
  contents: string
  author: string
  /** Annotation flags (/F): 4 = print, 2 = hidden. */
  flags: number
  color: RGB | null
  interior: RGB | null
  opacity: number
  borderWidth: number
  dash?: number[]
  vertices?: number[]
  line?: number[]
  inkList?: number[][]
  lineEnds?: [string, string]
  intent?: string
  cloud?: boolean
  measure?: MeasureSpec
  /** FreeText default appearance. */
  da?: { size: number; color: RGB }
  stampName?: string
  /** Full markup JSON (custom /PlanAsBuilt key). */
  payload: string
  ap: {
    stream: string
    gstates: Record<string, ExtGState>
    fonts: ('Helv' | 'HelvB')[]
    /** XObject names used (only 'Ic' for a device icon). */
    images: string[]
  }
  modified?: string
}

export interface BuildCtx {
  box: PageBox
  /** Points per foot for this page, or null. */
  ppf: number | null
  set?: SymbolSet
  /** True when an icon PNG is available under the XObject name Ic. */
  hasIcon?: boolean
  /** The device type's default mount shape (a device's own geometry.mount overrides it). */
  typeMount?: Mount
  /** Width of text in the label fonts. */
  textWidth: (s: string, size: number, bold?: boolean) => number
  areaPath?: string[]
  countNumber?: number
  showCones?: boolean
  /** Rows of a legend markup. */
  legendRows?: LegendRow[]
}

export const isPathGeom = (g: Markup['geometry']): g is PathGeometry => 'points' in g

/** Rough Helvetica width when no font metrics are at hand. */
export const approxTextWidth = (s: string, size: number, bold = false) => s.length * size * (bold ? 0.58 : 0.54)

const TYPE_LABEL: Record<string, string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', highlight: 'Highlight', text: 'Text', stamp: 'Stamp',
  device: 'Device', line: 'Line', arrow: 'Arrow', polyline: 'Polyline', polygon: 'Polygon', freehand: 'Freehand',
  cable: 'Cable', 'measure-length': 'Length', 'measure-polylength': 'Polyline length', 'measure-area': 'Area measurement', 'measure-radius': 'Radius',
  count: 'Count', area: 'Area', legend: 'Legend',
}

/** Readable summary, e.g. "Tag: CAM-01 | IP: 10.0.0.5 | Model: X". */
export function contentsOf(m: Markup, set: SymbolSet | undefined, measureText = ''): string {
  if (m.type === 'device') {
    const parts: string[] = []
    if (m.tag) parts.push(`Tag: ${m.tag}`)
    for (const d of [...(set?.fields ?? []), ...HARDWARE_FIELDS]) {
      const v = m.fields?.[d.key]
      if (v === undefined || v === '' || v === null) continue
      parts.push(`${d.key === 'ip' ? 'IP' : d.key === 'model' ? 'Model' : d.label}: ${typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v}`)
    }
    const st = STATUSES.find(s => s.value === m.status)
    if (st) parts.push(`Status: ${st.label}`)
    if (m.text) parts.push(m.text)
    return parts.join(' | ')
  }
  if (measureText) return m.text ? `${measureText} | ${m.text}` : measureText
  return m.text ?? ''
}

export const subjectOf = (m: Markup, set?: SymbolSet) => (m.type === 'device' && set ? set.name : TYPE_LABEL[m.type] ?? m.type)

export function scaleRatio(ppf: number): string {
  const ft = 72 / ppf
  return `1 in = ${Number(ft.toFixed(ft < 1 ? 4 : 3))} ft`
}

/** Count markers number 1, 2, 3... within their session group (same rule as the canvas). */
export function countNumbers(markups: Markup[]): Map<string, number> {
  const out = new Map<string, number>()
  const groups = new Map<string, Markup[]>()
  for (const m of markups) if (m.type === 'count') {
    const k = String(m.fields?.group ?? m.id)
    groups.set(k, [...(groups.get(k) ?? []), m])
  }
  for (const list of groups.values()) {
    list.sort((a, b) => Number(a.fields?.n ?? 0) - Number(b.fields?.n ?? 0))
    list.forEach((m, i) => out.set(m.id, i + 1))
  }
  return out
}

/** Local-frame extents collector. */
class Extent {
  pts: P[] = []
  add(x: number, y: number) { this.pts.push([x, y]); return this }
  box(x: number, y: number, w: number, h: number) { return this.add(x, y).add(x + w, y).add(x, y + h).add(x + w, y + h) }
  text(cx: number, baseline: number, w: number, size: number) { return this.box(cx - w / 2, baseline - size, w, size * 1.4) }
}

const RED: RGB = [0.878, 0.192, 0.192]
const GRAY: RGB = [0.525, 0.557, 0.584]
const round3 = (v: number) => Math.round(v * 1000) / 1000
const r4 = (r: number[]): Rect4 => [round3(r[0]), round3(r[1]), round3(r[2]), round3(r[3])]

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, steps = 8): number[] {
  const out: number[] = []
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  return out
}

/** Builds the annotation spec for one markup, or null when it has nothing to export. */
export function buildAnnot(m: Markup, ctx: BuildCtx): AnnotSpec | null {
  const g = m.geometry
  const { box } = ctx
  const M: Matrix = localMatrix(box, g.x, g.y, g.rotation || 0)
  const toP = (lx: number, ly: number): P => applyMatrix(M, lx, ly)
  const ops = new Ops()
  const ext = new Extent()
  /** Extra extents already in user space (the coverage cone). */
  const extra: P[] = []
  const stroke = hexToRgb(m.style.stroke)
  const fillC = hexToRgb(m.style.fill)
  const sw = m.style.strokeWidth || 1
  const opacity = m.style.opacity ?? 1
  const dash = m.style.dash ? [sw * 4, sw * 3] : undefined
  const hasStroke = !!m.style.stroke

  const spec: AnnotSpec = {
    markupId: m.id, subtype: 'Square', rect: [0, 0, 0, 0],
    subject: subjectOf(m, ctx.set), contents: '', author: m.created_by_name ?? m.updated_by_name ?? '',
    flags: 4, color: stroke, interior: fillC, opacity, borderWidth: sw, dash,
    payload: JSON.stringify(m),
    ap: { stream: '', gstates: {}, fonts: [], images: [] },
    modified: m.updated_at ?? m.created_at,
  }
  let pad = sw / 2 + 1
  let measureText = ''

  const gsMain: ExtGState = { CA: opacity, ca: opacity }
  if (m.type === 'highlight') gsMain.BM = 'Multiply'
  const begin = () => { ops.save().gs('GS', gsMain).cm(M).add('1 j 1 J') }
  begin()
  const styleStroke = () => { ops.stroke(stroke ?? RED).width(sw).dash(dash) }

  if (!isPathGeom(g)) {
    const b = g as BoxGeometry
    const w = b.width, h = b.height
    if (m.type !== 'legend') ext.box(0, 0, w, h)
    const corners = [toP(0, 0), toP(w, 0), toP(w, h), toP(0, h)]
    const cornerFlat = corners.flatMap(c => c)
    // axis-aligned in user space (no markup rotation, or a multiple of 90)
    const aligned = Math.abs(corners[0][0] - corners[1][0]) < 1e-6 || Math.abs(corners[0][1] - corners[1][1]) < 1e-6
    const shape = r4(boundsOf(corners))
    switch (m.type) {
      case 'rect':
      case 'ellipse': {
        if (hasStroke) styleStroke()
        if (fillC) ops.fill(fillC)
        if (m.type === 'rect') ops.rect(0, 0, w, h); else ops.ellipse(w / 2, h / 2, w / 2, h / 2)
        ops.paint(!!fillC, hasStroke)
        if (!hasStroke) spec.borderWidth = 0
        if (m.type === 'rect' && !aligned) { spec.subtype = 'Polygon'; spec.vertices = cornerFlat }
        else spec.subtype = m.type === 'rect' ? 'Square' : 'Circle'
        spec.inner = shape
        break
      }
      case 'highlight': {
        const c = fillC ?? [1, 0.831, 0.231]
        ops.fill(c).rect(0, 0, w, h).paint(true, false)
        spec.subtype = 'Square'; spec.borderWidth = 0; spec.interior = c; spec.color = null
        spec.inner = shape; pad = 0
        break
      }
      case 'cloud': {
        const size = Math.max(8, Math.min(24, Math.min(w, h) / 3))
        if (hasStroke) styleStroke()
        if (fillC) ops.fill(fillC)
        const flat: number[] = []
        for (const a of cloudArcs(w, h, size)) flat.push(...arcPoints(a.cx, a.cy, a.r, a.start, a.end))
        ops.poly(flat, true).paint(!!fillC, hasStroke)
        for (let i = 0; i < flat.length; i += 2) ext.add(flat[i], flat[i + 1])
        spec.subtype = 'Polygon'; spec.cloud = true; spec.vertices = cornerFlat
        if (!hasStroke) spec.borderWidth = 0
        break
      }
      case 'text': {
        const fs = m.style.fontSize || 18
        const tc = stroke ?? [0, 0, 0]
        if (fillC) ops.fill(fillC)
        if (hasStroke) ops.stroke(stroke!).width(Math.max(1, sw / 2)).dash(undefined)
        if (fillC || hasStroke) ops.rect(0, 0, w, h).paint(!!fillC, hasStroke)
        const lines = wrapText(m.text || 'Text', fs, Math.max(1, w - 12), (s, z) => ctx.textWidth(s, z))
        lines.forEach((ln, i) => { if (6 + i * fs * 1.15 < h) ops.text(ln, 6, 6 + fs * 0.9 + i * fs * 1.15, fs, tc) })
        spec.subtype = 'FreeText'; spec.da = { size: fs, color: tc }
        spec.borderWidth = hasStroke ? Math.max(1, sw / 2) : 0
        spec.contents = m.text
        spec.inner = shape
        break
      }
      case 'stamp': {
        const label = (m.text || 'STAMP').toUpperCase()
        const c = stroke ?? RED
        const fs = Math.max(6, Math.min(h * 0.55, (w - 16) / (label.length * 0.62)))
        ops.stroke(c).width(Math.max(2, sw)).dash(undefined)
        if (fillC) ops.fill(fillC)
        ops.roundRect(0, 0, w, h, Math.min(h / 4, 10)).paint(!!fillC, true)
        const tw = ctx.textWidth(label, fs, true)
        ops.text(label, (w - tw) / 2, h / 2 + fs * 0.35, fs, c, true)
        spec.subtype = 'Stamp'; spec.stampName = label; spec.borderWidth = 0
        pad = Math.max(2, sw) / 2 + 1
        break
      }
      case 'legend': {
        // Count table; height follows the rows. A colored dot stands in for the icon.
        const rows = ctx.legendRows ?? []
        const s = legendSettings(m)
        const fs = m.style.fontSize || 12
        const L = legendLayout(rows, s, w, fs)
        const ink = stroke ?? [0.2, 0.2, 0.25]
        const fit = (text: string, width: number, size: number, bold = false) => {
          let t = text
          while (t.length > 1 && ctx.textWidth(t, size, bold) > width) t = t.slice(0, -1)
          return t.length < text.length ? t.slice(0, Math.max(0, t.length - 1)) + '.' : t
        }
        ops.fill(fillC ?? [1, 1, 1]).stroke(ink).width(m.style.strokeWidth || 1).dash(undefined).rect(0, 0, w, L.height).paint(true, true)
        ext.box(0, 0, w, L.height)
        if (s.title.trim()) ops.text(fit(s.title, w - L.pad * 2, fs * 1.2, true), L.pad, L.pad * 0.8 + fs * 1.1, fs * 1.2, ink, true)
        let x0 = L.pad
        const colX: Record<string, number> = {}
        for (const c of s.columns) { colX[c] = x0; x0 += L.widths[c] }
        L.items.forEach((it, i) => {
          const top = L.titleH + L.pad + i * L.rowH
          const base = top + L.rowH / 2 + fs * 0.35
          if (it.kind === 'header') {
            ops.fill([0.945, 0.953, 0.961]).dash(undefined).rect(L.pad / 2, top, w - L.pad, L.rowH).paint(true, false)
            ops.text(fit(it.label, w - L.pad * 2, fs, true), L.pad, base, fs, ink, true)
            return
          }
          const r = it.row
          for (const c of s.columns) {
            if (c === 'icon') {
              const d = L.rowH * 0.64
              ops.fill(hexToRgb(r.color) ?? GRAY).dash(undefined)
              if (!r.mount || r.mount === 'ceiling') ops.ellipse(colX.icon + L.rowH * 0.5, top + L.rowH / 2, d / 2, d / 2)
              else ops.poly(outlineAt(mountShape(r.mount, d / 2), colX.icon + L.rowH * 0.5, top + L.rowH / 2), true)
              ops.paint(true, false)
              continue
            }
            const bold = c === 'count'
            const t = fit(legendCell(r, c), L.widths[c] - 4, fs, bold)
            const tw = ctx.textWidth(t, fs, bold)
            const al = legendAlign(s, c)
            const x = al === 'right' ? colX[c] + L.widths[c] - 4 - tw : al === 'center' ? colX[c] + (L.widths[c] - 4 - tw) / 2 : colX[c]
            ops.text(t, x, base, fs, c === 'name' || c === 'count' ? ink : [0.29, 0.31, 0.34], bold)
          }
        })
        if (!L.items.length) ops.text('No devices', L.pad, L.titleH + L.pad + fs, fs, GRAY)
        spec.subtype = 'Stamp'; spec.stampName = 'Legend'; spec.borderWidth = 0
        pad = (m.style.strokeWidth || 1) / 2 + 1
        spec.contents = ['Legend', s.title, ...rows.map(r => `${r.name}: ${r.count}`)].filter(Boolean).join(' | ')
        break
      }
      case 'device': {
        const set = ctx.set
        const color = hexToRgb(set?.color) ?? GRAY
        const r = Math.min(w, h) / 2
        const cx = w / 2, cy = h / 2
        // Coverage cone: a sibling of the device in page space, so it does not rotate with the device.
        const fov = ctx.showCones !== false && hasCoverage(b.fov) ? b.fov : undefined
        if (fov) {
          const dc = localToDisplay(b.x, b.y, b.rotation || 0)(cx, cy)
          const CM = localMatrix(box, dc.x, dc.y, 0)
          const poly = sectorPoints(rangePx(fov, ctx.ppf), fov.angle, fov.direction)
          ops.save().cm(CM).gs('GC', { ca: (fov.opacity ?? COVERAGE_OPACITY) * opacity, CA: opacity })
          ops.fill(color).stroke(color).width(1.5).dash(undefined).poly(poly, true).paint(true, true)
          ops.restore()
          for (let i = 0; i + 1 < poly.length; i += 2) extra.push(applyMatrix(CM, poly[i], poly[i + 1]))
        }
        const mount = resolveMount(ctx.typeMount, b.mount)
        const shape = mountShape(mount, r, wallFacing(b))
        ops.fill(color).stroke([1, 1, 1]).width(r * 0.12).dash(undefined)
        if (mount === 'ceiling') ops.ellipse(cx, cy, r, r)
        else ops.poly(outlineAt(shape, cx, cy), true)
        ops.paint(true, true)
        const ir = iconRect(shape)
        if (ctx.hasIcon) ops.image('Ic', cx + ir.x, cy + ir.y, ir.size, ir.size)
        const st = STATUSES.find(s => s.value === m.status)
        if (st) {
          ops.fill(hexToRgb(st.color) ?? GRAY).stroke([1, 1, 1]).width(r * 0.08)
            .ellipse(cx + r * 0.75, cy - r * 0.75, r * 0.3, r * 0.3).paint(true, true)
          ext.box(cx + r * 0.45, cy - r * 1.05, r * 0.6, r * 0.6)
        }
        const label = m.tag || set?.tag_prefix || '?'
        const fs = Math.max(4, r * 0.7)
        const tw = ctx.textWidth(label, fs, true)
        const base = cy + r + r * 0.12 + fs * 0.85
        ops.text(label, cx - tw / 2, base, fs, color, true, fs * 0.18)
        ext.text(cx, base, tw, fs)
        pad = r * 0.1 + 1
        spec.subtype = 'Stamp'; spec.stampName = set?.name ?? 'Device'; spec.borderWidth = 0
        break
      }
      default:
        return null
    }
  } else {
    const p = g as PathGeometry
    const pts = p.points
    if (pts.length < 2) return null
    for (let i = 0; i + 1 < pts.length; i += 2) ext.add(pts[i], pts[i + 1])
    const vertsPdf = () => { const o: number[] = []; for (let i = 0; i + 1 < pts.length; i += 2) o.push(...toP(pts[i], pts[i + 1])); return o }
    const labelFs = Math.min(80, Math.max(6, (m.style.fontSize || 16) * 0.7))
    const label = (text: string, at: { x: number; y: number }) => {
      const lines = text.split('\n')
      lines.forEach((ln, i) => {
        const tw = ctx.textWidth(ln, labelFs, true)
        const y = at.y - (labelFs * 1.2 * lines.length) / 2 + labelFs * 0.9 + i * labelFs * 1.2
        ops.text(ln, at.x - tw / 2, y, labelFs, stroke ?? RED, true, labelFs * 0.28)
        ext.text(at.x, y, tw, labelFs)
      })
      pad = Math.max(pad, 2)
    }
    const measured = (kind: 'length' | 'area', mid: { x: number; y: number }) => {
      if (!ctx.ppf) { label('Set scale', mid); return }
      const text = kind === 'length' ? formatFeetInches(feetOf(pts, ctx.ppf))
        : `${formatArea(sqftOf(pts, ctx.ppf))}\nP${formatFeetInches(polygonPerimeter(pts) / ctx.ppf)}`
      label(text, mid)
      spec.measure = { ratio: scaleRatio(ctx.ppf), pointsPerFoot: ctx.ppf }
      measureText = text.replace('\n', ', ')
    }
    const strokePath = (closed: boolean, fill?: RGB | null, fillAlpha?: number) => {
      styleStroke()
      if (fill) {
        if (fillAlpha !== undefined) ops.gs('GF', { ca: fillAlpha * opacity, CA: opacity })
        ops.fill(fill)
      }
      ops.poly(pts, closed).paint(!!fill, true)
      if (fill && fillAlpha !== undefined) ops.gs('GS', gsMain)
    }
    spec.color = stroke ?? RED
    switch (m.type) {
      case 'line':
      case 'arrow': {
        const [x0, y0, x1, y1] = pts.length >= 4 ? pts : [0, 0, pts[0], pts[1]]
        styleStroke(); ops.poly([x0, y0, x1, y1], false).paint(false, true)
        spec.subtype = 'Line'; spec.line = [...toP(x0, y0), ...toP(x1, y1)]
        if (m.type === 'arrow') {
          const pl = sw * 4 + 6, pw = sw * 3 + 6
          const len = Math.hypot(x1 - x0, y1 - y0) || 1
          const ux = (x1 - x0) / len, uy = (y1 - y0) / len
          const bx = x1 - ux * pl, by = y1 - uy * pl
          const lx = bx - uy * pw / 2, ly = by + ux * pw / 2, rx = bx + uy * pw / 2, ry = by - ux * pw / 2
          ops.fill(spec.color).poly([x1, y1, lx, ly, rx, ry], true).paint(true, false)
          ext.add(lx, ly).add(rx, ry)
          spec.lineEnds = ['None', 'ClosedArrow']; spec.interior = spec.color
        }
        break
      }
      case 'measure-length': {
        const [x0, y0, x1, y1] = pts.length >= 4 ? pts : [0, 0, pts[0], pts[1]]
        const len = Math.hypot(x1 - x0, y1 - y0) || 1
        const t = Math.max(sw * 2.5, 7)
        const nx = (-(y1 - y0) / len) * t, ny = ((x1 - x0) / len) * t
        styleStroke()
        ops.poly([x0, y0, x1, y1], false).paint(false, true)
        ops.poly([x0 - nx, y0 - ny, x0 + nx, y0 + ny], false).paint(false, true)
        ops.poly([x1 - nx, y1 - ny, x1 + nx, y1 + ny], false).paint(false, true)
        ext.add(x0 - nx, y0 - ny).add(x0 + nx, y0 + ny).add(x1 + nx, y1 + ny).add(x1 - nx, y1 - ny)
        measured('length', { x: (x0 + x1) / 2, y: (y0 + y1) / 2 })
        spec.subtype = 'Line'; spec.line = [...toP(x0, y0), ...toP(x1, y1)]
        if (spec.measure) spec.intent = 'LineDimension'
        break
      }
      case 'measure-radius': {
        const [cx, cy, ex, ey] = pts.length >= 4 ? pts : [pts[0], pts[1], pts[0], pts[1]]
        const r = Math.hypot(ex - cx, ey - cy)
        styleStroke()
        ops.ellipse(cx, cy, r, r).paint(false, true)
        ops.poly([cx, cy, ex, ey], false).paint(false, true)
        ext.box(cx - r, cy - r, r * 2, r * 2)
        const c = toP(cx, cy)
        spec.subtype = 'Circle'; spec.interior = null
        spec.inner = r4([c[0] - r, c[1] - r, c[0] + r, c[1] + r])
        if (ctx.ppf) {
          const text = formatRadius(r / ctx.ppf)
          label(text, { x: (cx + ex) / 2, y: (cy + ey) / 2 })
          spec.measure = { ratio: scaleRatio(ctx.ppf), pointsPerFoot: ctx.ppf }
          measureText = `${text}, D ${formatFeetInches((2 * r) / ctx.ppf)}, ${formatArea(Math.PI * (r / ctx.ppf) ** 2)}`
        } else label('Set scale', { x: (cx + ex) / 2, y: (cy + ey) / 2 })
        break
      }
      case 'measure-polylength': {
        strokePath(false)
        measured('length', pathMidpoint(pts))
        spec.subtype = 'PolyLine'; spec.vertices = vertsPdf()
        if (spec.measure) spec.intent = 'PolyLineDimension'
        break
      }
      case 'measure-area': {
        const base = fillC ?? stroke ?? RED
        strokePath(true, base, 0.22)
        measured('area', polygonCentroid(pts))
        spec.subtype = 'Polygon'; spec.vertices = vertsPdf(); spec.interior = base
        if (spec.measure) spec.intent = 'PolygonDimension'
        break
      }
      case 'polyline':
        strokePath(false); spec.subtype = 'PolyLine'; spec.vertices = vertsPdf()
        break
      case 'polygon':
        strokePath(true, fillC); spec.subtype = 'Polygon'; spec.vertices = vertsPdf()
        break
      case 'freehand':
        strokePath(false); spec.subtype = 'Ink'; spec.inkList = [vertsPdf()]
        break
      case 'cable': {
        strokePath(false)
        const rr = sw * 1.6
        ops.fill(stroke ?? RED).dash(undefined)
        ops.ellipse(pts[0], pts[1], rr, rr).paint(true, false)
        ops.ellipse(pts[pts.length - 2], pts[pts.length - 1], rr, rr).paint(true, false)
        ext.box(pts[0] - rr, pts[1] - rr, rr * 2, rr * 2).box(pts[pts.length - 2] - rr, pts[pts.length - 1] - rr, rr * 2, rr * 2)
        if (ctx.ppf) {
          measureText = formatFeetInches(feetOf(pts, ctx.ppf))
          label(measureText, pathMidpoint(pts))
        }
        spec.subtype = 'PolyLine'; spec.vertices = vertsPdf()
        break
      }
      case 'count': {
        const r = 9
        ops.fill(stroke ?? RED).stroke([1, 1, 1]).width(1.5).dash(undefined).ellipse(pts[0], pts[1], r, r).paint(true, true)
        const s = String(ctx.countNumber ?? '')
        const fs = r * (s.length > 1 ? 0.95 : 1.2)
        const tw = ctx.textWidth(s, fs, true)
        ops.text(s, pts[0] - tw / 2, pts[1] + fs * 0.35, fs, [1, 1, 1], true)
        ext.box(pts[0] - r, pts[1] - r, r * 2, r * 2)
        pad = 2
        const c = toP(pts[0], pts[1])
        spec.subtype = 'Circle'; spec.interior = stroke ?? RED; spec.borderWidth = 1.5; measureText = s
        spec.inner = r4([c[0] - r, c[1] - r, c[0] + r, c[1] + r])
        break
      }
      case 'area': {
        const sheet = m.fields?.sheet === true
        const color = stroke ?? hexToRgb('#5f7a99')!
        spec.color = color
        if (!sheet) {
          ops.gs('GF', { ca: 0.06 * opacity, CA: opacity }).fill(hexToRgb(m.style.fill) ?? color).poly(pts, true).paint(true, false)
          ops.gs('GS', gsMain)
          ops.stroke(color).width(sw).dash(dash).poly(pts, true).paint(false, true)
        }
        let ax = pts[0], ay = pts[1], best = Infinity
        for (let i = 0; i + 1 < pts.length; i += 2) if (pts[i] + pts[i + 1] < best) { best = pts[i] + pts[i + 1]; ax = pts[i]; ay = pts[i + 1] }
        const name = m.text.trim() || 'Unnamed area'
        const fs = 14
        const tw = ctx.textWidth(name, fs, true)
        ops.text(name, ax + 5, ay + 5 + fs * 0.9, fs, color, true, fs * 0.22)
        ext.text(ax + 5 + tw / 2, ay + 5 + fs * 0.9, tw, fs)
        spec.subtype = 'Polygon'; spec.vertices = vertsPdf(); spec.interior = null
        measureText = ctx.areaPath?.join(' > ') || name
        if (sheet) spec.flags = 4 | 2
        break
      }
      default:
        return null
    }
  }

  ops.restore()
  const mapped = [...ext.pts.map(([x, y]) => toP(x, y)), ...extra]
  const [x0, y0, x1, y1] = boundsOf(mapped)
  spec.rect = r4([x0 - pad, y0 - pad, x1 + pad, y1 + pad])
  if (spec.inner) {
    // never let the inner box escape the padded rect
    spec.inner = r4([Math.max(spec.inner[0], spec.rect[0]), Math.max(spec.inner[1], spec.rect[1]),
      Math.min(spec.inner[2], spec.rect[2]), Math.min(spec.inner[3], spec.rect[3])])
  }
  if (m.type !== 'legend') spec.contents = m.type === 'text' ? m.text : contentsOf(m, ctx.set, measureText)
  spec.ap = { stream: ops.toString(), gstates: ops.gstates, fonts: [...ops.fonts], images: [...ops.images] }
  return spec
}
