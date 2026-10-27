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
export function buildAppearance(doc: PDFDocument, spec: Pick<AnnotSpec, 'ap' | 'rect'>, res: Resources, iconKey?: string): PDFRef {
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

/** 16 uppercase letters derived from `seed` (Revu Sequence /IID: one id per numbering series). */
export function sequenceId(seed: string): string {
  let out = ''
  for (let k = 0; k < 4; k++) {
    let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    for (let j = 0; j < 4; j++) { out += String.fromCharCode(65 + (h % 26)); h = Math.floor(h / 26) }
  }
  return out
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')

/**
 * Writes a device's tag as a Revu grouped /FreeText child of the stamp (/RT /Group, /IRT stamp, /Sequence) and
 * records the group on the stamp (/GroupNesting [name stampNM childNM]).
 */
export function addTagChild(doc: PDFDocument, page: PDFPage, parent: PDFRef, spec: AnnotSpec, res: Resources, seqSeed: string): PDFRef | null {
  const t = spec.tagChild
  if (!t) return null
  const ctx = doc.context
  const nm = `${spec.markupId}-tag`
  const date = PDFString.of(pdfDate(spec.modified))
  const size = Math.round(t.size * 1000) / 1000
  const rgb = t.color.map(v => Math.round(v * 1000) / 1000)
  const hex = '#' + t.color.map(hex2).join('')
  const style = `font:bold Helvetica ${size}pt; text-align:center; text-valign:middle; margin:0pt; line-height:${Math.round(size * 0.575 * 1000) / 1000}pt; color:${hex}`
  const rc = `<?xml version="1.0"?><body xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:contentType="text/html" xfa:APIVersion="BluebeamPDFRevu:2018" xfa:spec="2.2.0" style="${style}" xmlns="http://www.w3.org/1999/xhtml"><p>${xml(t.text)}</p></body>`
  const d = ctx.obj({
    Type: 'Annot', Subtype: 'FreeText', F: 4, C: [], T: text(spec.author), Subj: text(spec.subject), NM: text(nm),
    CreationDate: date, M: date, Rect: t.rect,
    DA: PDFString.of(`${rgb.join(' ')} rg /HelvBld ${size} Tf`), DS: PDFString.of(style), RC: text(rc), Autosize: true,
    RT: 'Group', IRT: parent, Contents: text(t.text),
    BS: { W: 0, S: 'S', Type: 'Border' },
  }) as PDFDict
  if (t.index !== undefined) d.set(PDFName.of('Sequence'), ctx.obj({ IID: PDFString.of(sequenceId(`${seqSeed}|${t.prefix}`)), Index: t.index }))
  const ocg = spec.layerName ? ocgFor(doc, spec.layerName) : undefined
  if (ocg) d.set(PDFName.of('OC'), ocg)
  d.set(PDFName.of('AP'), ctx.obj({ N: buildAppearance(doc, t, res) }))
  const ref = ctx.register(d)
  page.node.addAnnot(ref)
  const head = ctx.lookupMaybe(parent, PDFDict)
  if (head) head.set(PDFName.of('GroupNesting'), ctx.obj([text(spec.subject), PDFName.of(spec.markupId), PDFName.of(nm)]))
  return ref
}

/** A Revu "Status" column entry: a Text reply (/IRT parent) with /StateModel Review and the status label as /State. */
export function addStatusReply(doc: PDFDocument, page: PDFPage, parent: PDFRef, spec: AnnotSpec): PDFRef | null {
  if (!spec.statusLabel) return null
  const ctx = doc.context
  const [x, y] = [Math.min(spec.rect[0], spec.rect[2]), Math.min(spec.rect[1], spec.rect[3])]
  const date = PDFString.of(pdfDate(spec.modified))
  const d = ctx.obj({
    Type: 'Annot', Subtype: 'Text', Name: 'Note', F: 30, C: [1, 1, 0],
    Subj: text(`Set to ${spec.statusLabel}`), T: text(spec.author), NM: text(`${spec.markupId}-status`),
    CreationDate: date, M: date, StateModel: text('Review'), State: text(spec.statusLabel),
    IRT: parent, Rect: [x, y, x + 18, y + 20],
  }) as PDFDict
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

/** An area as a Revu Space. */
export interface SpaceSpec {
  id: string
  title: string
  /** Flat x,y pairs in user space. */
  path: number[]
  color: [number, number, number]
  opacity: number
  /** Our full markup JSON, kept under /PABPayload so a re-import restores it exactly. */
  payload: string
  /** Id of the enclosing space in the same list, if any. */
  parentId: string | null
}

/** Writes Revu "Spaces" (/BSISpaces on the page, nested through /Kids and /Parent). */
export function addSpaces(doc: PDFDocument, page: PDFPage, spaces: SpaceSpec[]) {
  if (!spaces.length) return
  const ctx = doc.context
  const dicts = new Map<string, PDFDict>()
  const refs = new Map<string, PDFRef>()
  for (const sp of spaces) {
    const d = ctx.obj({
      Type: 'Space', Title: text(sp.title), C: sp.color, CA: sp.opacity,
      Path: chunk(sp.path), PABPayload: text(sp.payload),
    }) as PDFDict
    dicts.set(sp.id, d)
    refs.set(sp.id, ctx.register(d))
  }
  const top: PDFRef[] = []
  const kids = new Map<string, PDFRef[]>()
  for (const sp of spaces) {
    const pr = sp.parentId ? refs.get(sp.parentId) : undefined
    if (sp.parentId && pr) {
      dicts.get(sp.id)!.set(PDFName.of('Parent'), pr)
      const l = kids.get(sp.parentId)
      if (l) l.push(refs.get(sp.id)!); else kids.set(sp.parentId, [refs.get(sp.id)!])
    } else top.push(refs.get(sp.id)!)
  }
  for (const [id, list] of kids) dicts.get(id)!.set(PDFName.of('Kids'), ctx.obj(list))
  const existing = ctx.lookupMaybe(page.node.get(PDFName.of('BSISpaces')), PDFArray)
  if (existing) for (const r of top) existing.push(r)
  else page.node.set(PDFName.of('BSISpaces'), ctx.obj(top))
}

const chunk = (flat: number[]) => {
  const out: number[][] = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([Math.round(flat[i] * 1000) / 1000, Math.round(flat[i + 1] * 1000) / 1000])
  return out
}
