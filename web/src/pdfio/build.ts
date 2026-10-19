import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { PDFPage } from 'pdf-lib'
import { areaPathIn, buildAreaIndex, isArea } from '../markups/areas'
import type { Markup, SymbolSet } from '../markups/types'
import { approxTextWidth, buildAnnot, countNumbers } from './annots'
import type { AnnotSpec } from './annots'
import { sanitizeText } from './stream'
import { addAnnotation, flattenAnnotation, pageBoxOf } from './writer'
import type { Resources } from './writer'

export interface ExportInput {
  pdfBytes: ArrayBuffer | Uint8Array
  markups: Markup[]
  symbolSets: Map<string, SymbolSet>
  /** Points per foot by page number (1-based). */
  scales: Map<number, number>
  /** Icon PNG bytes by symbol set id (optional; devices export without an icon when missing). */
  icons?: Map<string, Uint8Array>
  /** Draw coverage cones (default true). */
  showCones?: boolean
}

export type Mode = 'annotate' | 'flatten'

/** Loads fonts and icon images into `doc`, returns what the appearance builders need. */
export async function prepareResources(doc: PDFDocument, icons?: Map<string, Uint8Array>): Promise<Resources> {
  const Helv = await doc.embedFont(StandardFonts.Helvetica)
  const HelvB = await doc.embedFont(StandardFonts.HelveticaBold)
  const map = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()
  for (const [id, bytes] of icons ?? []) {
    try { map.set(id, await doc.embedPng(bytes)) } catch { /* unusable icon: device draws without it */ }
  }
  return { Helv, HelvB, icons: map }
}

export function textWidthFn(res: Resources) {
  return (s: string, size: number, bold = false) => {
    try { return (bold ? res.HelvB : res.Helv).widthOfTextAtSize(sanitizeText(s), size) } catch { return approxTextWidth(s, size, bold) }
  }
}

/** Specs for one page's markups (areas first so they sit underneath). */
export function specsForPage(page: PDFPage, markups: Markup[], input: ExportInput, res: Resources, counts: Map<string, number>,
  areaPaths: Map<string, string[]>, pageNumber: number): { spec: AnnotSpec; iconKey?: string }[] {
  const box = pageBoxOf(page)
  const tw = textWidthFn(res)
  const out: { spec: AnnotSpec; iconKey?: string }[] = []
  const ordered = [...markups.filter(m => m.type === 'area'), ...markups.filter(m => m.type !== 'area')]
  for (const m of ordered) {
    const set = m.symbol_set_id ? input.symbolSets.get(m.symbol_set_id) : undefined
    const iconKey = set && res.icons.has(set.id) ? set.id : undefined
    const spec = buildAnnot(m, {
      box, ppf: input.scales.get(pageNumber) ?? null, set, hasIcon: !!iconKey, textWidth: tw,
      areaPath: areaPaths.get(m.id), countNumber: counts.get(m.id), showCones: input.showCones,
    })
    if (spec) out.push({ spec, iconKey })
  }
  return out
}

/** Applies all markups to an already-loaded document. Returns how many were written. */
export function applyMarkups(doc: PDFDocument, mode: Mode, input: ExportInput, res: Resources): number {
  const pages = doc.getPages()
  const byPage = new Map<number, Markup[]>()
  for (const m of input.markups) {
    if (m.page < 1 || m.page > pages.length) continue // markups on missing pages (shorter revision) have no sheet to land on
    const l = byPage.get(m.page)
    if (l) l.push(m); else byPage.set(m.page, [m])
  }
  const idx = buildAreaIndex(input.markups.filter(isArea))
  const areaPaths = new Map(input.markups.filter(isArea).map(a => [a.id, areaPathIn(idx, a)]))
  const counts = countNumbers(input.markups)
  let n = 0
  for (const [pageNumber, list] of byPage) {
    const page = pages[pageNumber - 1]
    for (const { spec, iconKey } of specsForPage(page, list, input, res, counts, areaPaths, pageNumber)) {
      if (mode === 'annotate') addAnnotation(doc, page, spec, res, iconKey)
      else if (!(spec.flags & 2)) flattenAnnotation(doc, page, spec, res, iconKey)
      n++
    }
  }
  return n
}

async function run(mode: Mode, input: ExportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(input.pdfBytes, { ignoreEncryption: true })
  const res = await prepareResources(doc, input.icons)
  applyMarkups(doc, mode, input, res)
  return doc.save()
}

/** Source PDF plus one real, editable annotation per markup. */
export const exportAnnotated = (input: ExportInput) => run('annotate', input)

/** Source PDF with the markups drawn into the page content. */
export const exportFlattened = (input: ExportInput) => run('flatten', input)

export const exportFileName = (docName: string, suffix: string) =>
  `${docName.replace(/[\/:*?"<>|]+/g, '_').trim() || 'plan'}-${suffix}.pdf`
