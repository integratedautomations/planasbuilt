import { pathFromPoints } from '../markups/geometry'
import { BOX_TYPES, DEFAULT_STYLE, STATUSES } from '../markups/types'
import type { BoxGeometry, Markup, MarkupStyle, MarkupType, PathGeometry, Status } from '../markups/types'
import { boundsOf, fromPdf } from './coords'
import type { PageBox } from './coords'
import type { RawAnnot } from './reader'
import { rgbToHex } from './stream'

/** What a foreign annotation becomes; the caller supplies id / document. */
export interface MappedMarkup {
  page: number
  type: MarkupType
  geometry: BoxGeometry | PathGeometry
  style: MarkupStyle
  text: string
  author: string
}

const ARROWS = ['OpenArrow', 'ClosedArrow', 'RClosedArrow', 'ROpenArrow', 'Butt', 'Slash', 'Diamond']
const isArrow = (e?: string) => !!e && ARROWS.includes(e)

function styleOf(a: RawAnnot, extra: Partial<MarkupStyle> = {}): MarkupStyle {
  const stroke = a.color && a.color.length && a.borderWidth > 0 ? rgbToHex(a.color) : ''
  const fill = a.interior && a.interior.length ? rgbToHex(a.interior) : ''
  return {
    ...DEFAULT_STYLE, stroke, fill, strokeWidth: a.borderWidth > 0 ? a.borderWidth : DEFAULT_STYLE.strokeWidth,
    opacity: a.opacity, dash: a.dash ? true : undefined, ...extra,
  }
}

/** Display-space points from user-space coordinates. */
function displayPoints(box: PageBox, flat: number[]): { x: number; y: number }[] {
  const out = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push(fromPdf(box, flat[i], flat[i + 1]))
  return out
}

/** Box geometry (unrotated, display space) covering a user-space rect. */
export function boxFromPdfRect(box: PageBox, rect: number[]): BoxGeometry {
  const a = fromPdf(box, rect[0], rect[1]), b = fromPdf(box, rect[2], rect[3])
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y), rotation: 0 }
}

/** /Rect with /RD margins removed (the shape's real bounds). */
export function innerRect(a: RawAnnot): number[] {
  const x0 = Math.min(a.rect[0], a.rect[2]), y0 = Math.min(a.rect[1], a.rect[3])
  const x1 = Math.max(a.rect[0], a.rect[2]), y1 = Math.max(a.rect[1], a.rect[3])
  const rd = a.rd
  if (!rd || rd.length < 4) return [x0, y0, x1, y1]
  const r = [x0 + rd[0], y0 + rd[1], x1 - rd[2], y1 - rd[3]]
  return r[2] > r[0] && r[3] > r[1] ? r : [x0, y0, x1, y1]
}

function parseDa(da?: string) {
  const size = da ? /([\d.]+)\s+Tf/.exec(da) : null
  const rgb = da ? /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da) : null
  const gray = da && !rgb ? /([\d.]+)\s+g\b/.exec(da) : null
  return {
    size: size ? parseFloat(size[1]) : undefined,
    color: rgb ? rgbToHex([parseFloat(rgb[1]), parseFloat(rgb[2]), parseFloat(rgb[3])]) : gray ? rgbToHex([parseFloat(gray[1])]) : undefined,
  }
}

function pathMarkup(box: PageBox, flat: number[], type: MarkupType, a: RawAnnot, style: MarkupStyle): MappedMarkup | null {
  const pts = displayPoints(box, flat)
  if (pts.length < 2) return null
  return { page: a.page, type, geometry: pathFromPoints(pts), style, text: a.contents, author: a.author }
}

/**
 * Maps a standard annotation to our markup types (PlanAsBuilt payloads are handled before this).
 * Returns [] for subtypes we don't import (notes, links, ...). Ink with several strokes gives several markups.
 */
export function mapAnnotation(a: RawAnnot, box: PageBox): MappedMarkup[] {
  const one = (m: MappedMarkup | null) => (m ? [m] : [])
  const base = { page: a.page, text: a.contents, author: a.author }
  switch (a.subtype) {
    case 'Square':
    case 'Circle': {
      // our highlights are borderless translucent squares (what Revu calls a highlight-style rectangle)
      if (a.subtype === 'Square' && a.borderWidth === 0 && a.interior?.length && a.opacity < 1)
        return mapAnnotation({ ...a, subtype: 'Highlight', color: a.interior, quadPoints: undefined }, box)
      const type = a.subtype === 'Square' ? 'rect' : 'ellipse'
      return [{ ...base, type, geometry: boxFromPdfRect(box, innerRect(a)), style: styleOf(a), text: '' }]
    }
    case 'Highlight': {
      const q = a.quadPoints && a.quadPoints.length >= 8 ? a.quadPoints : a.rect
      const pts: [number, number][] = []
      for (let i = 0; i + 1 < q.length; i += 2) pts.push([q[i], q[i + 1]])
      const [x0, y0, x1, y1] = boundsOf(pts)
      const fill = a.color && a.color.length ? rgbToHex(a.color) : '#ffd43b'
      return [{ ...base, type: 'highlight', geometry: boxFromPdfRect(box, [x0, y0, x1, y1]), text: '',
        style: { ...DEFAULT_STYLE, stroke: '', fill, opacity: a.opacity < 1 ? a.opacity : 0.4 } }]
    }
    case 'FreeText': {
      const da = parseDa(a.da)
      return [{ ...base, type: 'text', geometry: boxFromPdfRect(box, innerRect(a)),
        style: { ...DEFAULT_STYLE, stroke: da.color ?? '#000000', fill: a.interior?.length ? rgbToHex(a.interior) : '',
          strokeWidth: a.borderWidth > 0 ? a.borderWidth : 1, fontSize: da.size ?? 18, opacity: a.opacity } }]
    }
    case 'Stamp': {
      const label = a.contents || a.stampName || 'STAMP'
      return [{ ...base, type: 'stamp', geometry: boxFromPdfRect(box, a.rect), text: label,
        style: { ...DEFAULT_STYLE, stroke: a.color?.length ? rgbToHex(a.color) : '#e03131', fontSize: 28, opacity: a.opacity } }]
    }
    case 'Line': {
      if (!a.line || a.line.length < 4) return []
      let [x0, y0, x1, y1] = a.line
      const [e0, e1] = [a.lineEnds?.[0], a.lineEnds?.[1]]
      let type: MarkupType = 'line'
      if (a.intent === 'LineDimension') type = 'measure-length'
      else if (isArrow(e0) || isArrow(e1)) {
        type = 'arrow'
        if (isArrow(e0) && !isArrow(e1)) [x0, y0, x1, y1] = [x1, y1, x0, y0]
      }
      return one(pathMarkup(box, [x0, y0, x1, y1], type, a, styleOf(a, { fill: '' })))
    }
    case 'PolyLine':
      return one(pathMarkup(box, a.vertices ?? [], a.intent === 'PolyLineDimension' ? 'measure-polylength' : 'polyline', a, styleOf(a, { fill: '' })))
    case 'Polygon': {
      const v = a.vertices ?? []
      if (a.cloud) {
        const pts = displayPoints(box, v)
        if (pts.length < 3) return []
        const [x0, y0, x1, y1] = boundsOf(pts.map(p => [p.x, p.y] as [number, number]))
        return [{ ...base, type: 'cloud', geometry: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rotation: 0 }, style: styleOf(a), text: '' }]
      }
      return one(pathMarkup(box, v, a.intent === 'PolygonDimension' ? 'measure-area' : 'polygon', a, styleOf(a)))
    }
    case 'Ink':
      return (a.inkList ?? []).flatMap(stroke => one(pathMarkup(box, stroke, 'freehand', a, styleOf(a, { fill: '' }))))
    default:
      return []
  }
}

/** Ids that exist locally; payload references to anything else are dropped. */
export interface KnownIds {
  layers: ReadonlySet<string>
  symbolSets: ReadonlySet<string>
  deviceTypes: ReadonlySet<string>
  products: ReadonlySet<string>
}
export const NO_KNOWN_IDS: KnownIds = { layers: new Set(), symbolSets: new Set(), deviceTypes: new Set(), products: new Set() }

const BOX_SET: ReadonlySet<string> = new Set(BOX_TYPES)
const PATH_SET: ReadonlySet<string> = new Set(['line', 'arrow', 'polyline', 'polygon', 'freehand', 'cable',
  'measure-length', 'measure-polylength', 'measure-area', 'count', 'area'])
const STATUS_SET: ReadonlySet<string> = new Set(STATUSES.map(s => s.value))
const MAX_COORD = 1e6
const MAX_POINTS = 40_000
const MAX_TEXT = 10_000
const MAX_FIELDS = 64
const MAX_FIELD_STR = 2_000

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD ? v : null)
const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt
const COLOR = /^#[0-9a-fA-F]{3,8}$/
const color = (v: unknown, dflt: string) => (typeof v === 'string' && (v === '' || COLOR.test(v)) ? v : dflt)
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const refId = (v: unknown, known: ReadonlySet<string>): string | null => (typeof v === 'string' && known.has(v) ? v : null)

function cleanStyle(v: unknown): MarkupStyle {
  const s = isObj(v) ? v : {}
  const out: MarkupStyle = {
    stroke: color(s.stroke, DEFAULT_STYLE.stroke), fill: color(s.fill, DEFAULT_STYLE.fill),
    strokeWidth: clamp(s.strokeWidth, 0, 200, DEFAULT_STYLE.strokeWidth), opacity: clamp(s.opacity, 0, 1, DEFAULT_STYLE.opacity),
    fontSize: clamp(s.fontSize, 1, 1000, DEFAULT_STYLE.fontSize),
  }
  if (s.dash === true) out.dash = true
  return out
}

function cleanGeometry(type: string, g: unknown): BoxGeometry | PathGeometry | null {
  if (!isObj(g)) return null
  const x = num(g.x), y = num(g.y)
  if (x === null || y === null) return null
  const rotation = g.rotation === undefined ? 0 : num(g.rotation)
  if (rotation === null) return null
  if (BOX_SET.has(type)) {
    const width = num(g.width), height = num(g.height)
    if (width === null || height === null) return null
    const out: BoxGeometry = { x, y, width, height, rotation }
    if (isObj(g.fov)) {
      const direction = num(g.fov.direction), angle = num(g.fov.angle), range = num(g.fov.range)
      if (direction !== null && angle !== null && range !== null) {
        out.fov = { direction, angle, range }
        if (g.fov.hidden === true) out.fov.hidden = true
      }
    }
    return out
  }
  const pts = g.points
  if (!Array.isArray(pts) || pts.length % 2 !== 0 || pts.length > MAX_POINTS) return null
  const points: number[] = []
  for (const p of pts) { const n = num(p); if (n === null) return null; points.push(n) }
  return { x, y, rotation, points }
}

function cleanFields(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, string | number | boolean> = {}
  let n = 0
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k.length > 64) continue
    if (n >= MAX_FIELDS) break
    if (typeof val === 'string') out[k] = val.slice(0, MAX_FIELD_STR)
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
    else if (typeof val === 'boolean') out[k] = val
    else continue
    n++
  }
  return out
}

/**
 * Whitelists and normalizes an untrusted markup (PDF JSON): known type, finite geometry, validated style,
 * capped text/fields, and references to layers / symbol sets / catalog entries only when they exist locally.
 * Returns null when the geometry or type is unusable.
 */
export function sanitizeMarkup(raw: unknown, known: KnownIds = NO_KNOWN_IDS): Markup | null {
  if (!isObj(raw)) return null
  const type = raw.type
  if (typeof type !== 'string' || !(BOX_SET.has(type) || PATH_SET.has(type))) return null
  const geometry = cleanGeometry(type, raw.geometry)
  if (!geometry) return null
  if (typeof raw.id !== 'string' || !/^[\w.-]{1,100}$/.test(raw.id)) return null
  const m: Markup = {
    id: raw.id, document_id: typeof raw.document_id === 'string' ? raw.document_id.slice(0, 100) : '',
    page: typeof raw.page === 'number' && Number.isInteger(raw.page) && raw.page >= 1 && raw.page <= 100_000 ? raw.page : 1,
    type: type as MarkupType, geometry, style: cleanStyle(raw.style), text: str(raw.text, MAX_TEXT),
    layer_id: refId(raw.layer_id, known.layers),
  }
  if (raw.symbol_set_id !== undefined) m.symbol_set_id = refId(raw.symbol_set_id, known.symbolSets)
  if (raw.device_type_id !== undefined) m.device_type_id = refId(raw.device_type_id, known.deviceTypes)
  if (raw.product_id !== undefined) m.product_id = refId(raw.product_id, known.products)
  if (raw.tag !== undefined) m.tag = str(raw.tag, 64)
  if (typeof raw.status === 'string' && STATUS_SET.has(raw.status)) m.status = raw.status as Status
  const fields = cleanFields(raw.fields)
  if (fields) m.fields = fields
  return m
}

/** Parses a /PlanAsBuilt payload; null when it isn't a markup we can safely restore. */
export function parsePayload(json: string | undefined, known: KnownIds = NO_KNOWN_IDS): Markup | null {
  if (!json || json.length > 5_000_000) return null
  try { return sanitizeMarkup(JSON.parse(json), known) } catch { return null }
}
