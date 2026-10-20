import { loadPdf } from '../pdf'
import { AnnotationMode } from 'pdfjs-dist'
import { loadPdfBytes } from '../offline/cache'
import type { Catalog } from '../catalog/catalog'
import type { DeviceType } from '../catalog/types'
import type { Markup, SymbolSet } from '../markups/types'
import { loadIcons } from './icons'
import { buildSubset } from './pageSubset'
import { buildPrintHtml, markupsForPrint, planPrint } from './printPlan'
import type { PrintImage, PrintOptions } from './printPlan'

export interface RasterArgs {
  documentId: string
  markups: Iterable<Markup>
  symbolSets: Map<string, SymbolSet>
  deviceTypes?: Iterable<DeviceType>
  scales: Map<number, number>
  showCones?: boolean
  catalog?: Catalog
  /** PDF to print; defaults to the document's stored current PDF. */
  pdfBytes?: ArrayBuffer | Uint8Array
  /** false hides the PDF's own baked-in annotations (see annotVisibility). */
  showOriginalAnnots?: boolean
}

export interface RasterResult {
  images: PrintImage[]
  /** Frees the image blobs. */
  revoke: () => void
}

export class PrintAbortError extends Error {
  constructor() { super('Print cancelled'); this.name = 'AbortError' }
}
export const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new PrintAbortError() }

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
  canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not make a print image (page too large?)'))), 'image/jpeg', 0.92))

/**
 * Renders the chosen pages, markups included, to JPEG images at the chosen quality. Markups and layers are drawn
 * by the PDF builder (so legends, cones and icons match the exports) and pdf.js rasterizes the result one page at a
 * time, so only one canvas is in memory at once; very large sheets render at a lower dpi (see MAX_PRINT_PIXELS).
 */
export async function renderPrintImages(a: RasterArgs, o: PrintOptions, pages: number[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<RasterResult> {
  throwIfAborted(signal)
  const pdfBytes = a.pdfBytes ?? await loadPdfBytes(a.documentId)
  throwIfAborted(signal)
  const markups = markupsForPrint(a.markups, o)
  const icons = markups ? await loadIcons(a.symbolSets.values(), a.deviceTypes) : undefined
  throwIfAborted(signal)
  const subset = await buildSubset({
    pdfBytes, pages, mode: 'flatten', icons, markups, scales: a.scales, symbolSets: a.symbolSets, showCones: a.showCones, catalog: a.catalog,
  })
  throwIfAborted(signal)
  // pdf.js takes ownership of the buffer it is given
  const task = loadPdf(subset.buffer.slice(subset.byteOffset, subset.byteOffset + subset.byteLength) as ArrayBuffer)
  const urls: string[] = []
  const revoke = () => { urls.splice(0).forEach(u => URL.revokeObjectURL(u)) }
  try {
    const pdf = await task.promise
    const sizes = new Map<number, { width: number; height: number }>()
    for (let i = 0; i < pages.length; i++) {
      const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 })
      sizes.set(pages[i], { width: vp.width, height: vp.height })
      throwIfAborted(signal)
    }
    const plans = planPrint(pages, sizes, o)
    const images: PrintImage[] = []
    for (let i = 0; i < plans.length; i++) {
      throwIfAborted(signal)
      const plan = plans[i]
      const page = await pdf.getPage(i + 1)
      const win = o.range === 'window' && o.window && o.window.page === plan.page ? o.window : null
      const viewport = win
        ? page.getViewport({ scale: plan.scale, offsetX: -win.x * plan.scale, offsetY: -win.y * plan.scale })
        : page.getViewport({ scale: plan.scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, win ? plan.pxWidth : Math.floor(viewport.width))
      canvas.height = Math.max(1, win ? plan.pxHeight : Math.floor(viewport.height))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('This browser cannot make print images')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const renderTask = page.render({ canvas, canvasContext: ctx, viewport, annotationMode: a.showOriginalAnnots === false ? AnnotationMode.DISABLE : AnnotationMode.ENABLE })
      const onAbort = () => renderTask.cancel()
      signal?.addEventListener('abort', onAbort)
      try { await renderTask.promise } catch (e) { if (signal?.aborted) throw new PrintAbortError(); throw e } finally { signal?.removeEventListener('abort', onAbort) }
      throwIfAborted(signal)
      const blob = await toBlob(canvas)
      canvas.width = 0; canvas.height = 0 // release the bitmap before the next page
      const src = URL.createObjectURL(blob)
      urls.push(src)
      images.push({ src, plan })
      onProgress?.(i + 1, plans.length)
    }
    return { images, revoke }
  } catch (e) {
    revoke()
    throw e
  } finally {
    void task.destroy()
  }
}

/**
 * Opens the system print dialog for the images through a hidden iframe. The dialog (not this app) lists the real
 * printers and their paper sizes; the pages use `size: auto`, so the printer's paper is used.
 */
export function printImages(r: RasterResult, o: PrintOptions, title: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { r.revoke(); reject(new PrintAbortError()); return }
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    let cleaned = false
    const cleanup = () => { if (cleaned) return; cleaned = true; frame.remove(); r.revoke() }
    frame.onload = async () => {
      const win = frame.contentWindow
      if (signal?.aborted) { cleanup(); reject(new PrintAbortError()); return }
      if (!win) { cleanup(); reject(new Error('Could not open the print preview')); return }
      try {
        await Promise.all([...win.document.images].map(img => img.decode().catch(() => undefined)))
        if (signal?.aborted) { cleanup(); reject(new PrintAbortError()); return }
        win.addEventListener('afterprint', () => setTimeout(cleanup, 500))
        win.focus()
        win.print()
        setTimeout(cleanup, 20 * 60_000) // some browsers never report afterprint
        resolve()
      } catch (e) { cleanup(); reject(e as Error) }
    }
    frame.srcdoc = buildPrintHtml(r.images, o, title)
    document.body.appendChild(frame)
  })
}
