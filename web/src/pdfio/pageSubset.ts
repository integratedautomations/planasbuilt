import { PDFDocument, PrintScaling } from 'pdf-lib'
import type { Markup, SymbolSet } from '../markups/types'
import { applyMarkups, prepareResources } from './build'
import type { Mode } from './build'

export interface SubsetInput {
  pdfBytes: ArrayBuffer | Uint8Array
  /** 1-based pages to keep, in output order. */
  pages: number[]
  /** Markups of the whole document; those on kept pages are renumbered and drawn. Omit for a plain page copy. */
  markups?: Markup[]
  symbolSets?: Map<string, SymbolSet>
  scales?: Map<number, number>
  icons?: Map<string, Uint8Array>
  showCones?: boolean
  /** How markups are written: editable annotations or drawn into the page. */
  mode?: Mode
  /** false asks the PDF viewer to print at 100% instead of shrinking to the printable area. */
  fitToPage?: boolean
}

/** A new PDF with only `pages` (renumbered 1..n) and, optionally, their markups. */
export async function buildSubset(input: SubsetInput): Promise<Uint8Array> {
  const src = await PDFDocument.load(input.pdfBytes, { ignoreEncryption: true })
  const total = src.getPageCount()
  if (!input.pages.length || input.pages.some(p => !Number.isInteger(p) || p < 1 || p > total)) throw new Error('Pick pages that exist in this plan')
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, input.pages.map(p => p - 1))
  copied.forEach(p => out.addPage(p))
  const newNumber = new Map(input.pages.map((p, i) => [p, i + 1]))
  if (input.markups) {
    const markups = input.markups.filter(m => newNumber.has(m.page)).map(m => ({ ...m, page: newNumber.get(m.page)! }))
    const scales = new Map<number, number>()
    for (const [p, ppf] of input.scales ?? []) { const n = newNumber.get(p); if (n) scales.set(n, ppf) }
    const res = await prepareResources(out, input.icons)
    applyMarkups(out, input.mode ?? 'annotate', { pdfBytes: input.pdfBytes, markups, symbolSets: input.symbolSets ?? new Map(), scales, icons: input.icons, showCones: input.showCones }, res)
  }
  if (input.fitToPage !== undefined) {
    out.catalog.getOrCreateViewerPreferences().setPrintScaling(input.fitToPage ? PrintScaling.AppDefault : PrintScaling.None)
  }
  return out.save()
}

/** "all" / "1-3,5" to sorted unique pages. Returns an error message instead of throwing so a dialog can show it. */
export function parsePageRange(text: string, count: number): { pages: number[]; error?: string } {
  const out = new Set<number>()
  const parts = text.split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) return { pages: [], error: 'Enter pages like 1-3, 5' }
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!m) return { pages: [], error: `"${part}" is not a page or range` }
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a) return { pages: [], error: `"${part}" is not a valid range` }
    if (b > count) return { pages: [], error: `This plan has ${count} page${count === 1 ? '' : 's'}` }
    for (let p = a; p <= b; p++) out.add(p)
  }
  return { pages: [...out].sort((x, y) => x - y) }
}
