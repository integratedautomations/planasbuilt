import { drawObject, popGraphicsState, pushGraphicsState, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFPage, PDFRef, PDFString } from 'pdf-lib'
import type { PDFFont, PDFImage } from 'pdf-lib'
import { normRotation } from './coords'
import type { PageBox } from './coords'
import type { AnnotSpec } from './annots'
import { sanitizeText } from './stream'

export function pageBoxOf(page: PDFPage): PageBox {
  const cb = page.getCropBox()
  return { llx: cb.x, lly: cb.y, width: cb.width, height: cb.height, rotation: normRotation(page.getRotation().angle) }
}

export interface Resources {
  Helv: PDFFont
  HelvB: PDFFont
  /** Icon PNGs by symbol set id. */
  icons: Map<string, PDFImage>
}

export function pdfDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  const t = Number.isNaN(d.getTime()) ? new Date() : d
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `D:${p(t.getUTCFullYear(), 4)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}Z`
}

const text = (s: string) => PDFHexString.fromText(s)
const nums = (doc: PDFDocument, a: number[]) => doc.context.obj(a) as PDFArray

/** The /AP form XObject for a spec; BBox = Rect, content already in user space. */
export function buildAppearance(doc: PDFDocument, spec: AnnotSpec, res: Resources, iconKey?: string): PDFRef {
  const gs: Record<string, any> = {}
  for (const [name, g] of Object.entries(spec.ap.gstates)) {
    gs[name] = { Type: 'ExtGState', ...(g.CA !== undefined ? { CA: g.CA } : {}), ...(g.ca !== undefined ? { ca: g.ca } : {}), ...(g.BM ? { BM: g.BM } : {}) }
  }
  const fonts: Record<string, PDFRef> = {}
  for (const f of spec.ap.fonts) fonts[f] = res[f].ref
  const xobj: Record<string, PDFRef> = {}
  const icon = iconKey ? res.icons.get(iconKey) : undefined
  if (spec.ap.images.includes('Ic') && icon) xobj.Ic = icon.ref
  const resources = doc.context.obj({
    ...(Object.keys(gs).length ? { ExtGState: gs } : {}),
    ...(Object.keys(fonts).length ? { Font: fonts } : {}),
    ...(Object.keys(xobj).length ? { XObject: xobj } : {}),
  })
  const stream = doc.context.stream(spec.ap.stream, {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: spec.rect, Resources: resources,
  })
  return doc.context.register(stream)
}

function numberFormat(doc: PDFDocument, unit: string, c: number) {
  return doc.context.obj({ Type: 'NumberFormat', U: PDFString.of(unit), C: c, F: 'D', D: 100, FD: false })
}

/** One optional content group per name, registered in /OCProperties (/OCGs, /D /Order, /D /ON). */
export function ocgFor(doc: PDFDocument, name: string): PDFRef {
  const ctx = doc.context
  const cat = doc.catalog
  let props = ctx.lookupMaybe(cat.get(PDFName.of('OCProperties')), PDFDict)
  if (!props) { props = ctx.obj({ OCGs: [], D: {} }) as PDFDict; cat.set(PDFName.of('OCProperties'), props) }
  let ocgs = ctx.lookupMaybe(props.get(PDFName.of('OCGs')), PDFArray)
  if (!ocgs) { ocgs = ctx.obj([]) as PDFArray; props.set(PDFName.of('OCGs'), ocgs) }
  for (let i = 0; i < ocgs.size(); i++) {
    const g = ctx.lookupMaybe(ocgs.get(i), PDFDict)
    const n = g && ctx.lookup(g.get(PDFName.of('Name')))
    if (g && n && 'decodeText' in n && (n as PDFString).decodeText() === name) return ocgs.get(i) as PDFRef
  }
  const ref = ctx.register(ctx.obj({ Type: 'OCG', Name: text(name) }))
  ocgs.push(ref)
  let d = ctx.lookupMaybe(props.get(PDFName.of('D')), PDFDict)
  if (!d) { d = ctx.obj({}) as PDFDict; props.set(PDFName.of('D'), d) }
  let order = ctx.lookupMaybe(d.get(PDFName.of('Order')), PDFArray)
  if (!order) { order = ctx.obj([]) as PDFArray; d.set(PDFName.of('Order'), order) }
  order.push(ref)
  return ref
}

/** Builds the annotation dictionary (with /AP) and appends it to the page. Returns its ref. */
export function addAnnotation(doc: PDFDocument, page: PDFPage, spec: AnnotSpec, res: Resources, iconKey?: string): PDFRef {
  const ctx = doc.context
  const d = ctx.obj({
    Type: 'Annot', Subtype: spec.subtype, Rect: spec.rect, F: spec.flags,
    NM: text(spec.markupId), T: text(spec.author), Subj: text(spec.subject), Contents: text(spec.contents),
    M: PDFString.of(pdfDate(spec.modified)), CA: spec.opacity,
    PlanAsBuilt: text(spec.payload),
  }) as PDFDict
  if (spec.color) d.set(PDFName.of('C'), nums(doc, spec.color))
  if (spec.interior) d.set(PDFName.of('IC'), nums(doc, spec.interior))
  const bs: Record<string, any> = { Type: 'Border', W: spec.borderWidth, S: spec.dash ? 'D' : 'S' }
  if (spec.dash) bs.D = spec.dash
  d.set(PDFName.of('BS'), ctx.obj(bs))
  if (spec.vertices) d.set(PDFName.of('Vertices'), nums(doc, spec.vertices))
  if (spec.line) d.set(PDFName.of('L'), nums(doc, spec.line))
  if (spec.inkList) d.set(PDFName.of('InkList'), ctx.obj(spec.inkList))
  if (spec.lineEnds) d.set(PDFName.of('LE'), ctx.obj(spec.lineEnds))
  if (spec.intent) d.set(PDFName.of('IT'), PDFName.of(spec.intent))
  if (spec.cloud) d.set(PDFName.of('BE'), ctx.obj({ S: 'C', I: 1 }))
  if (spec.inner && ['Square', 'Circle', 'FreeText'].includes(spec.subtype)) {
    const [r0, r1, r2, r3] = spec.rect, [i0, i1, i2, i3] = spec.inner
    d.set(PDFName.of('RD'), nums(doc, [i0 - r0, i1 - r1, r2 - i2, r3 - i3]))
  }
  if (spec.da) {
    const c = spec.da.color
    d.set(PDFName.of('DA'), PDFString.of(`/Helv ${spec.da.size} Tf ${c.map(v => Math.round(v * 1000) / 1000).join(' ')} rg`))
    d.set(PDFName.of('Q'), PDFNumber.of(0))
  }
  if (spec.stampName) d.set(PDFName.of('Name'), PDFName.of(sanitizeText(spec.stampName).replace(/[^A-Za-z0-9_-]+/g, '_') || 'Stamp'))
  if (spec.measure) {
    const ft = 1 / spec.measure.pointsPerFoot
    d.set(PDFName.of('Measure'), ctx.obj({
      Type: 'Measure', Subtype: 'RL', R: PDFString.of(spec.measure.ratio),
      X: [numberFormat(doc, 'ft', ft)], D: [numberFormat(doc, 'ft', 1)], A: [numberFormat(doc, 'sq ft', 1)],
    }))
  }
  if (spec.label) d.set(PDFName.of('Label'), text(spec.label))
  const ocg = spec.layerName ? ocgFor(doc, spec.layerName) : undefined
  if (ocg) d.set(PDFName.of('OC'), ocg)
  const cols = Object.entries(spec.columns ?? {})
  if (cols.length) d.set(PDFName.of('BSIColumnData'), ctx.obj(Object.fromEntries(cols.map(([k, v]) => [k, text(v)]))))
  d.set(PDFName.of('AP'), ctx.obj({ N: buildAppearance(doc, spec, res, iconKey) }))
  const ref = ctx.register(d)
  page.node.addAnnot(ref)
  return ref
}

let flattenSeq = 0

/** Draws the appearance into the page content (no annotation). */
export function flattenAnnotation(doc: PDFDocument, page: PDFPage, spec: AnnotSpec, res: Resources, iconKey?: string) {
  const ref = buildAppearance(doc, spec, res, iconKey)
  const name = PDFName.of(`PabFlat${++flattenSeq}`)
  page.node.setXObject(name, ref)
  page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState())
}
