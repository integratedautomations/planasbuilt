import type { Markup } from '../markups/types'
import { parsePageRange } from './pageSubset'
import { printableMarkups } from './printOptions'

// Print planning: which pages, how big each raster is, and the print-only HTML document. Pure, so it can be tested.
// The browser's own print dialog picks the printer, paper size, copies and duplex (pages use `size: auto`), so the
// printer's real paper is used; each page image is scaled to fit the printable area.

export type PrintRange = 'all' | 'current' | 'custom' | 'selected' | 'window'

/** A region of one page, in PDF page coordinates (points at scale 1, origin top-left, as the viewer and markups use). */
export interface PrintWindow { page: number; x: number; y: number; width: number; height: number }

/** Normalises two dragged corners into a window; null when it is too small to be a deliberate selection. */
export function windowFromCorners(page: number, a: { x: number; y: number }, b: { x: number; y: number }, bounds?: { width: number; height: number }, minSize = 4): PrintWindow | null {
  let x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y)
  if (bounds) { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(bounds.width, x1); y1 = Math.min(bounds.height, y1) }
  if (x1 - x0 < minSize || y1 - y0 < minSize) return null
  return { page, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
export type PrintOrientation = 'auto' | 'portrait' | 'landscape'
export type PrintMargins = 'none' | 'narrow' | 'normal'
export type PrintQuality = 'draft' | 'normal' | 'high'

export interface PrintOptions {
  range: PrintRange
  /** For range === 'custom', e.g. "1-3,5". */
  custom: string
  /** Fit each page to the paper (true) or print at actual size (false: PDF points map to 1/72 inch). */
  fit: boolean
  orientation: PrintOrientation
  margins: PrintMargins
  includeMarkups: boolean
  /** Layer keys left unchecked: custom layer ids, '' for the default layer, `set:<id>` for symbol sets. */
  hiddenLayers: string[]
  /** Legend tables on the plan are printed (when markups are on). */
  includeLegend: boolean
  grayscale: boolean
  quality: PrintQuality
  /** For range === 'window': the region to print. */
  window: PrintWindow | null
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  range: 'all', custom: '', fit: true, orientation: 'auto', margins: 'narrow', includeMarkups: true,
  hiddenLayers: [], includeLegend: true, grayscale: false, quality: 'normal', window: null,
}

export const QUALITY_DPI: Record<PrintQuality, number> = { draft: 150, normal: 200, high: 300 }
export const MARGIN_INCHES: Record<PrintMargins, number> = { none: 0, narrow: 0.25, normal: 0.5 }
/** Largest raster, in pixels, rendered for one page (keeps big sheets from exhausting memory). */
export const MAX_PRINT_PIXELS = 36_000_000

function normalizeWindow(raw: unknown): PrintWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!ok(w.page) || !ok(w.x) || !ok(w.y) || !ok(w.width) || !ok(w.height) || w.width <= 0 || w.height <= 0 || w.page < 1) return null
  return { page: w.page, x: w.x, y: w.y, width: w.width, height: w.height }
}

/** Accepts saved prefs of any shape and returns complete options. */
export function normalizePrintOptions(raw: unknown): PrintOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const D = DEFAULT_PRINT_OPTIONS
  const pick = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d)
  return {
    range: pick(r.range, ['all', 'current', 'custom', 'selected', 'window'] as const, D.range),
    custom: typeof r.custom === 'string' ? r.custom : '',
    fit: typeof r.fit === 'boolean' ? r.fit : D.fit,
    orientation: pick(r.orientation, ['auto', 'portrait', 'landscape'] as const, D.orientation),
    margins: pick(r.margins, ['none', 'narrow', 'normal'] as const, D.margins),
    includeMarkups: typeof r.includeMarkups === 'boolean' ? r.includeMarkups : D.includeMarkups,
    hiddenLayers: Array.isArray(r.hiddenLayers) && r.hiddenLayers.every(x => typeof x === 'string') ? r.hiddenLayers : [],
    includeLegend: typeof r.includeLegend === 'boolean' ? r.includeLegend : D.includeLegend,
    grayscale: typeof r.grayscale === 'boolean' ? r.grayscale : D.grayscale,
    quality: pick(r.quality, ['draft', 'normal', 'high'] as const, D.quality),
    window: normalizeWindow(r.window),
  }
}

/** Pages a print job covers, or an error for the dialog. `selected` are the pages picked in the Pages panel. */
export function printPageList(o: Pick<PrintOptions, 'range' | 'custom'> & { window?: PrintWindow | null }, current: number, count: number, selected: number[] = []): { pages: number[]; error?: string } {
  if (o.range === 'all') return { pages: Array.from({ length: count }, (_, i) => i + 1) }
  if (o.range === 'current') return { pages: [current] }
  if (o.range === 'window') {
    return o.window && o.window.page >= 1 && o.window.page <= count ? { pages: [o.window.page] } : { pages: [], error: 'Choose a window on the page first' }
  }
  if (o.range === 'selected') {
    const pages = [...new Set(selected)].filter(p => p >= 1 && p <= count).sort((a, b) => a - b)
    return pages.length ? { pages } : { pages: [], error: 'Select pages in the Pages panel first (Ctrl or Shift click)' }
  }
  return parsePageRange(o.custom, count)
}

/** Markups to draw for a print: layers filtered, legends optional. */
export function markupsForPrint(markups: Iterable<Markup>, o: Pick<PrintOptions, 'includeMarkups' | 'hiddenLayers' | 'includeLegend'>): Markup[] | undefined {
  if (!o.includeMarkups) return undefined
  const list = printableMarkups(markups, o.hiddenLayers)
  return o.includeLegend ? list : list.filter(m => m.type !== 'legend')
}

/** Orientation a page prints in. Auto follows the sheet's own shape; a fixed choice applies to every page. */
export function pageOrientation(widthPt: number, heightPt: number, o: PrintOrientation): 'portrait' | 'landscape' {
  if (o !== 'auto') return o
  return widthPt > heightPt ? 'landscape' : 'portrait'
}

export interface PrintPagePlan {
  page: number
  orientation: 'portrait' | 'landscape'
  /** Page size in inches at actual size (PDF points / 72). */
  widthIn: number
  heightIn: number
  /** Raster size in pixels and the dpi it works out to (lower than asked when the cap applies). */
  pxWidth: number
  pxHeight: number
  dpi: number
  /** Scale to give pdf.js (pixels per PDF point). */
  scale: number
}

/** Raster size for a page at the requested dpi, reduced when it would pass the pixel cap. */
export function planRaster(widthPt: number, heightPt: number, quality: PrintQuality, maxPixels = MAX_PRINT_PIXELS) {
  const wIn = widthPt / 72, hIn = heightPt / 72
  let dpi = QUALITY_DPI[quality]
  if (wIn * dpi * hIn * dpi > maxPixels) dpi = Math.sqrt(maxPixels / (wIn * hIn))
  return { dpi, scale: dpi / 72, pxWidth: Math.max(1, Math.round(wIn * dpi)), pxHeight: Math.max(1, Math.round(hIn * dpi)) }
}

export function planPrint(pages: number[], sizes: Map<number, { width: number; height: number }>, o: Pick<PrintOptions, 'orientation' | 'quality'> & { range?: PrintRange; window?: PrintWindow | null }): PrintPagePlan[] {
  return pages.map(page => {
    const w = o.range === 'window' && o.window && o.window.page === page ? o.window : null
    const s = w ? { width: w.width, height: w.height } : sizes.get(page) ?? { width: 612, height: 792 }
    const r = planRaster(s.width, s.height, o.quality)
    return { page, orientation: pageOrientation(s.width, s.height, o.orientation), widthIn: s.width / 72, heightIn: s.height / 72, pxWidth: r.pxWidth, pxHeight: r.pxHeight, dpi: r.dpi, scale: r.scale }
  })
}

const inch = (n: number) => `${Math.round(n * 1000) / 1000}in`

export interface PrintImage { src: string; plan: PrintPagePlan }

/**
 * The print-only HTML document. `@page { size: auto }` leaves the paper to the printer chosen in the system print
 * dialog; with automatic orientation, landscape sheets use a named page so the browser turns the paper to match.
 * One image per sheet, scaled with object-fit: contain inside the printable area (or at actual size).
 */
export function buildPrintHtml(images: PrintImage[], o: Pick<PrintOptions, 'fit' | 'margins' | 'orientation' | 'grayscale'>, title = 'Plan'): string {
  const m = inch(MARGIN_INCHES[o.margins])
  const named = o.orientation === 'auto'
  const pageRule = o.orientation === 'auto' ? 'auto' : o.orientation
  const css = [
    `@page { size: ${pageRule}; margin: ${m}; }`,
    named ? `@page port { size: portrait; margin: ${m}; }\n@page land { size: landscape; margin: ${m}; }` : '',
    'html, body { margin: 0; padding: 0; background: #fff; }',
    '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    '.sheet { box-sizing: border-box; break-after: page; page-break-after: always; overflow: hidden; }',
    '.sheet:last-child { break-after: auto; page-break-after: auto; }',
    named ? '.sheet.portrait { page: port; }\n.sheet.landscape { page: land; }' : '',
    '.sheet.fit { width: 100%; height: 100vh; }',
    '.sheet.fit img { display: block; width: 100%; height: 100%; object-fit: contain; }',
    '.sheet.actual img { display: block; }',
    o.grayscale ? 'img { filter: grayscale(1); }' : '',
  ].filter(Boolean).join('\n')
  const sheets = images.map(({ src, plan }) => {
    const style = o.fit ? '' : ` style="width:${inch(plan.widthIn)};height:${inch(plan.heightIn)}"`
    return `<div class="sheet ${o.fit ? 'fit' : 'actual'} ${plan.orientation}"><img src="${src}" alt="Page ${plan.page}"${style}></div>`
  }).join('\n')
  const safe = title.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safe}</title><style>\n${css}\n</style></head><body>\n${sheets}\n</body></html>`
}

/** Settings for the "Save as PDF" path (the existing PDF builder). */
export function pdfSettings(o: PrintOptions, pages: number[]) {
  return { range: 'custom' as const, custom: pages.join(','), fit: o.fit, includeMarkups: o.includeMarkups, hiddenLayers: o.includeLegend ? o.hiddenLayers : o.hiddenLayers }
}
