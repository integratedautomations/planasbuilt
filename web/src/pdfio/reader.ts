import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib'
import type { PDFObject } from 'pdf-lib'
import { pageBoxOf } from './writer'
import type { PageBox } from './coords'

/** A PDF annotation reduced to the fields the importer cares about (all coordinates in user space). */
export interface RawAnnot {
  /** 1-based page number. */
  page: number
  subtype: string
  rect: number[]
  /** /RD margins (left, bottom, right, top). */
  rd?: number[]
  contents: string
  author: string
  name: string
  subject: string
  color: number[] | null
  interior: number[] | null
  opacity: number
  borderWidth: number
  dash?: number[]
  vertices?: number[]
  line?: number[]
  inkList?: number[][]
  quadPoints?: number[]
  lineEnds?: string[]
  intent?: string
  cloud?: boolean
  da?: string
  stampName?: string
  flags: number
  /** Our custom /PlanAsBuilt key (full markup JSON). */
  payload?: string
  /** Object reference ("12 0 R"), for resolving /IRT. */
  ref?: string
  /** /IRT target reference and /RT relation (Revu groups use /RT /Group). */
  irt?: string
  rt?: string
  /** Optional-content layer name (/OC), e.g. a Revu layer. */
  layer?: string
  /** Revu "Label" column (/Label). */
  label?: string
  /** Custom columns (/BSIColumnData). */
  columns?: Record<string, string>
  /** Has an /Image key (Revu embeds an image inside the annotation). */
  hasImage?: boolean
  /** Points per foot from /Measure (/X /C is feet per point), when present. */
  measurePpf?: number
}

type Dict = PDFDict

function numbers(doc: PDFDocument, d: Dict, key: string): number[] | undefined {
  const a = doc.context.lookupMaybe(d.get(PDFName.of(key)), PDFArray)
  if (!a) return undefined
  const out: number[] = []
  for (let i = 0; i < a.size(); i++) {
    const n = doc.context.lookupMaybe(a.get(i), PDFNumber)
    if (!n) return undefined
    out.push(n.asNumber())
  }
  return out
}

function str(doc: PDFDocument, d: Dict, key: string): string {
  const o = doc.context.lookup(d.get(PDFName.of(key)))
  if (o instanceof PDFString || o instanceof PDFHexString) { try { return o.decodeText() } catch { return '' } }
  if (o instanceof PDFName) return o.decodeText()
  return ''
}

const refKey = (v: PDFObject | undefined) => (v instanceof PDFRef ? v.toString() : undefined)

function nameOf(doc: PDFDocument, v: PDFObject | undefined): string {
  const o = v ? doc.context.lookup(v) : undefined
  return o instanceof PDFName ? o.decodeText() : ''
}

/** Name of the optional-content group (or the first group of a membership dict) behind /OC. */
function layerNameOf(doc: PDFDocument, d: Dict): string | undefined {
  const oc = doc.context.lookupMaybe(d.get(PDFName.of('OC')), PDFDict)
  if (!oc) return undefined
  const own = str(doc, oc, 'Name')
  if (own) return own
  const groups = oc.get(PDFName.of('OCGs'))
  const first = groups instanceof PDFArray ? doc.context.lookupMaybe(groups.get(0), PDFDict) : doc.context.lookupMaybe(groups, PDFDict)
  return first ? str(doc, first, 'Name') || undefined : undefined
}

function columnsOf(doc: PDFDocument, d: Dict): Record<string, string> | undefined {
  const c = doc.context.lookupMaybe(d.get(PDFName.of('BSIColumnData')), PDFDict)
  if (!c) return undefined
  const out: Record<string, string> = {}
  for (const [k] of c.entries()) { const v = str(doc, c, k.decodeText()); if (v) out[k.decodeText()] = v }
  return Object.keys(out).length ? out : undefined
}

function measurePpfOf(doc: PDFDocument, d: Dict): number | undefined {
  const m = doc.context.lookupMaybe(d.get(PDFName.of('Measure')), PDFDict)
  const x = m ? doc.context.lookupMaybe(m.get(PDFName.of('X')), PDFArray) : undefined
  const nf = x ? doc.context.lookupMaybe(x.get(0), PDFDict) : undefined
  const c = nf ? doc.context.lookupMaybe(nf.get(PDFName.of('C')), PDFNumber)?.asNumber() : undefined
  return c && c > 0 && Number.isFinite(1 / c) ? 1 / c : undefined
}

/** Reads every markup-type annotation of the document (links, widgets and popups are skipped). */
export function readAnnotations(doc: PDFDocument): { page: number; box: PageBox; annots: RawAnnot[] }[] {
  const out: { page: number; box: PageBox; annots: RawAnnot[] }[] = []
  doc.getPages().forEach((page, i) => {
    const list = page.node.Annots()
    const annots: RawAnnot[] = []
    for (let k = 0; list && k < list.size(); k++) {
      const d = doc.context.lookupMaybe(list.get(k), PDFDict)
      if (!d) continue
      const subtype = nameOf(doc, d.get(PDFName.of('Subtype')))
      if (!subtype || ['Link', 'Widget', 'Popup'].includes(subtype)) continue
      const rect = numbers(doc, d, 'Rect')
      if (!rect || rect.length < 4) continue
      const bs = doc.context.lookupMaybe(d.get(PDFName.of('BS')), PDFDict)
      const border = numbers(doc, d, 'Border')
      let borderWidth = border && border.length >= 3 ? border[2] : 1
      let dash: number[] | undefined
      if (bs) {
        const w = doc.context.lookupMaybe(bs.get(PDFName.of('W')), PDFNumber)
        if (w) borderWidth = w.asNumber()
        if (nameOf(doc, bs.get(PDFName.of('S'))) === 'D') dash = numbers(doc, bs, 'D') ?? [3]
      }
      const ink: number[][] = []
      const inkArr = doc.context.lookupMaybe(d.get(PDFName.of('InkList')), PDFArray)
      for (let j = 0; inkArr && j < inkArr.size(); j++) {
        const sub = doc.context.lookupMaybe(inkArr.get(j), PDFArray)
        if (!sub) continue
        const pts: number[] = []
        for (let q = 0; q < sub.size(); q++) { const n = doc.context.lookupMaybe(sub.get(q), PDFNumber); if (n) pts.push(n.asNumber()) }
        ink.push(pts)
      }
      const le = doc.context.lookupMaybe(d.get(PDFName.of('LE')), PDFArray)
      const lineEnds: string[] = []
      for (let q = 0; le && q < le.size(); q++) lineEnds.push(nameOf(doc, le.get(q)))
      const be = doc.context.lookupMaybe(d.get(PDFName.of('BE')), PDFDict)
      const ca = doc.context.lookupMaybe(d.get(PDFName.of('CA')), PDFNumber)
      const f = doc.context.lookupMaybe(d.get(PDFName.of('F')), PDFNumber)
      const payload = str(doc, d, 'PlanAsBuilt')
      annots.push({
        page: i + 1, subtype, rect, rd: numbers(doc, d, 'RD'),
        contents: str(doc, d, 'Contents'), author: str(doc, d, 'T'), name: str(doc, d, 'NM'), subject: str(doc, d, 'Subj'),
        color: numbers(doc, d, 'C') ?? null, interior: numbers(doc, d, 'IC') ?? null,
        opacity: ca ? ca.asNumber() : 1, borderWidth, dash,
        vertices: numbers(doc, d, 'Vertices'), line: numbers(doc, d, 'L'),
        inkList: ink.length ? ink : undefined, quadPoints: numbers(doc, d, 'QuadPoints'),
        lineEnds: lineEnds.length ? lineEnds : undefined, intent: nameOf(doc, d.get(PDFName.of('IT'))) || undefined,
        cloud: !!be && nameOf(doc, be.get(PDFName.of('S'))) === 'C',
        da: str(doc, d, 'DA') || undefined,
        stampName: nameOf(doc, d.get(PDFName.of('Name'))) || undefined,
        flags: f ? f.asNumber() : 0,
        payload: payload || undefined,
        ref: refKey(list.get(k)),
        irt: refKey(d.get(PDFName.of('IRT'))),
        rt: nameOf(doc, d.get(PDFName.of('RT'))) || undefined,
        layer: layerNameOf(doc, d),
        label: str(doc, d, 'Label') || undefined,
        columns: columnsOf(doc, d),
        hasImage: d.has(PDFName.of('Image')) || undefined,
        measurePpf: measurePpfOf(doc, d),
      })
    }
    out.push({ page: i + 1, box: pageBoxOf(page), annots })
  })
  return out
}
