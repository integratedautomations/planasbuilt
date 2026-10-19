import { loadPdfBytes } from '../offline/cache'
import type { Markup, SymbolSet } from '../markups/types'
import type { DeviceType } from '../catalog/types'
import { loadIcons } from './icons'
import { buildSubset } from './pageSubset'
import { printableMarkups, printPages } from './printOptions'
import type { PrintSettings } from './printOptions'

export { DEFAULT_PRINT } from './printOptions'
export type { PrintSettings } from './printOptions'

export interface PrintArgs {
  documentId: string
  markups: Iterable<Markup>
  symbolSets: Map<string, SymbolSet>
  deviceTypes?: Iterable<DeviceType>
  scales: Map<number, number>
  showCones?: boolean
  /** PDF to print; defaults to the document's stored current PDF. */
  pdfBytes?: ArrayBuffer | Uint8Array
}

/** Builds the PDF to print: chosen pages only, markups drawn in (filtered by layer) when asked. */
export async function buildPrintPdf(a: PrintArgs, s: PrintSettings, current: number, pageCount: number): Promise<Uint8Array> {
  const { pages, error } = printPages(s, current, pageCount)
  if (error) throw new Error(error)
  const pdfBytes = a.pdfBytes ?? await loadPdfBytes(a.documentId)
  const icons = s.includeMarkups ? await loadIcons(a.symbolSets.values(), a.deviceTypes) : undefined
  return buildSubset({
    pdfBytes, pages, fitToPage: s.fit, mode: 'flatten', icons, scales: a.scales, symbolSets: a.symbolSets, showCones: a.showCones,
    markups: s.includeMarkups ? printableMarkups(a.markups, s.hiddenLayers) : undefined,
  })
}

/**
 * Prints PDF bytes through a hidden iframe. Falls back to opening the PDF in a new tab (the viewer there has its own
 * print button) when the browser will not print an embedded PDF.
 */
export function printPdfBytes(bytes: Uint8Array): Promise<'printed' | 'opened'> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const cleanup = (frame?: HTMLIFrameElement) => setTimeout(() => { frame?.remove(); URL.revokeObjectURL(url) }, 60_000)
  const fallback = () => { window.open(url, '_blank'); cleanup(); return 'opened' as const }
  return new Promise(resolve => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    let settled = false
    const done = (r: 'printed' | 'opened') => { if (!settled) { settled = true; resolve(r) } }
    frame.onload = () => {
      try {
        frame.contentWindow!.focus()
        frame.contentWindow!.print()
        cleanup(frame)
        done('printed')
      } catch { frame.remove(); done(fallback()) }
    }
    frame.onerror = () => { frame.remove(); done(fallback()) }
    // Some browsers never fire load for a PDF in a hidden frame.
    setTimeout(() => { if (!settled) { frame.remove(); done(fallback()) } }, 8000)
    frame.src = url
    document.body.appendChild(frame)
  })
}
