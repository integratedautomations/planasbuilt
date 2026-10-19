import { pathFromPoints } from '../markups/geometry'
import { DEFAULT_STYLE } from '../markups/types'
import type { BoxGeometry, Markup, MarkupStyle, MarkupType, PathGeometry } from '../markups/types'
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

/** Parses a /PlanAsBuilt payload; null when it isn't a markup we can restore. */
export function parsePayload(json: string | undefined): Markup | null {
  if (!json) return null
  try {
    const m = JSON.parse(json)
    if (m && typeof m === 'object' && typeof m.type === 'string' && m.geometry && typeof m.geometry === 'object'
      && typeof m.geometry.x === 'number' && typeof m.geometry.y === 'number') return m as Markup
  } catch { /* not ours */ }
  return null
}
