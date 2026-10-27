import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { PDFPage } from 'pdf-lib'
import { areaPathIn, buildAreaIndex, isArea, areaName, isSheetArea } from '../markups/areas'
import { EMPTY_CATALOG } from '../catalog/catalog'
import type { Catalog } from '../catalog/catalog'
import { deviceCentreOf, linkedEnds } from '../markups/cables'
import type { EndRing } from '../markups/cables'
import { legendRowsFor } from '../markups/legend'
import type { LegendRow } from '../markups/legend'
import type { Markup, SymbolSet } from '../markups/types'
import { approxTextWidth, buildAnnot, countNumbers } from './annots'
import type { AnnotSpec } from './annots'
import { sanitizeText } from './stream'
import { addAnnotation, addSpaces, addStatusReply, addTagChild, flattenAnnotation, pageBoxOf } from './writer'
import type { SpaceSpec } from './writer'
import { hexToRgb } from './stream'
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
  /** Catalog for legend tables (device type and product names). */
  catalog?: Catalog
  /** Rows of each legend by markup id; computed from `markups` when omitted (pass it when `markups` is only part of the document). */
  legendRows?: Map<string, LegendRow[]>
  /** Annotation author (/T) options; see `authorOptions`. Default: the literal PlanAsBuilt. */
  authorMode?: 'plan' | 'placer' | 'fixed'
  author?: string
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

/** Linked ends of a cable with the device each meets (centre and symbol radius). */
function cableRingsOf(m: Markup, byId: ReadonlyMap<string, Markup>): EndRing[] {
  const g = m.geometry
  if (!('points' in g)) return []
  const out: EndRing[] = []
  for (const end of linkedEnds(m, byId)) {
    const d = byId.get(g[end]!)
    const c = deviceCentreOf(d)
    if (d && c && 'width' in d.geometry) out.push({ end, c, r: Math.min(d.geometry.width, d.geometry.height) / 2 })
  }
  return out
}

/** Specs for one page's markups (areas first so they sit underneath). */
export function specsForPage(page: PDFPage, markups: Markup[], input: ExportInput, res: Resources, counts: Map<string, number>,
  areaPaths: Map<string, string[]>, pageNumber: number, legend?: Map<string, LegendRow[]>, locations?: Map<string, string>, separateTag = false): { spec: AnnotSpec; iconKey?: string }[] {
  const box = pageBoxOf(page)
  const tw = textWidthFn(res)
  const out: { spec: AnnotSpec; iconKey?: string }[] = []
  const ordered = [...markups.filter(m => m.type === 'area'), ...markups.filter(m => m.type !== 'area')]
  const byId = new Map(markups.map(m => [m.id, m]))
  for (const m of ordered) {
    const set = m.symbol_set_id ? input.symbolSets.get(m.symbol_set_id) : undefined
    const typeKey = m.device_type_id ? `type:${m.device_type_id}` : ''
    const iconKey = typeKey && res.icons.has(typeKey) ? typeKey : set && res.icons.has(set.id) ? set.id : undefined
    const spec = buildAnnot(m, {
      separateTag,
      box, ppf: input.scales.get(pageNumber) ?? null, set, hasIcon: !!iconKey, textWidth: tw,
      typeMount: m.device_type_id ? input.catalog?.types.get(m.device_type_id)?.mount : undefined,
      areaPath: areaPaths.get(m.id), authorMode: input.authorMode, author: input.author, location: locations?.get(m.id),
      typeName: m.device_type_id ? input.catalog?.types.get(m.device_type_id)?.name : undefined, countNumber: counts.get(m.id), showCones: input.showCones, legendRows: legend?.get(m.id),
      cableRings: m.type === 'cable' ? cableRingsOf(m, byId) : undefined,
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
  const legend = input.legendRows ?? legendRowsFor(input.markups, input.catalog ?? EMPTY_CATALOG, input.symbolSets)
  const locations = new Map<string, string>()
  for (const m of input.markups) {
    if (m.type !== 'device') continue
    const path = areaPathIn(idx, m)
    if (path.length) locations.set(m.id, path[path.length - 1])
  }
  let n = 0
  const byId = new Map(input.markups.map(m => [m.id, m]))
  const spaceIdsOnPage = new Set<string>()
  for (const [pageNumber, list] of byPage) {
    const page = pages[pageNumber - 1]
    const spaces: SpaceSpec[] = []
    for (const { spec, iconKey } of specsForPage(page, list, input, res, counts, areaPaths, pageNumber, legend, locations, mode === 'annotate')) {
      const m = byId.get(spec.markupId)
      if (mode === 'annotate' && m && isArea(m) && !isSheetArea(m)) {
        // areas are Revu Spaces, not annotations
        const spaceIds = spaceIdsOnPage
        if (spec.vertices && spec.vertices.length >= 6) {
          spaceIds.add(m.id)
          spaces.push({
            id: m.id, title: areaName(m), path: spec.vertices, color: spec.color && spec.color.length === 3 ? spec.color as [number, number, number] : (hexToRgb(m.style.fill || m.style.stroke, [0.37, 0.48, 0.6]) as [number, number, number]),
            opacity: 0.1, payload: spec.payload, parentId: null,
          })
          n++
        }
        continue
      }
      if (mode === 'annotate') { const pr = addAnnotation(doc, page, spec, res, iconKey); addTagChild(doc, page, pr, spec, res, byId.get(spec.markupId)?.document_id ?? ''); addStatusReply(doc, page, pr, spec) }
      else if (!(spec.flags & 2)) flattenAnnotation(doc, page, spec, res, iconKey)
      n++
    }
    for (const sp of spaces) {
      // nearest exported ancestor (the sheet area and anything unexported is skipped)
      let p = idx.parents.get(sp.id) ?? null
      for (let k = 0; p && !spaceIdsOnPage.has(p) && k < 1000; k++) p = idx.parents.get(p) ?? null
      sp.parentId = p && spaceIdsOnPage.has(p) ? p : null
    }
    spaceIdsOnPage.clear()
    addSpaces(doc, page, spaces)
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
