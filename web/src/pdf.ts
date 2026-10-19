import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type PDFDocumentProxy = pdfjs.PDFDocumentProxy
export type PDFPageProxy = pdfjs.PDFPageProxy

/** Returns the loading task; call task.destroy() to free the document and its worker data. */
export function loadPdf(src: string | ArrayBuffer) {
  return pdfjs.getDocument(typeof src === 'string' ? { url: src } : { data: src })
}

// Browsers (especially iOS Safari) fail on very large canvases; keep under ~16 MP.
export const MAX_CANVAS_PIXELS = 16_000_000

export function clampRenderScale(page: PDFPageProxy, wanted: number) {
  const vp = page.getViewport({ scale: 1 })
  const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height))
  return Math.min(wanted, maxScale)
}
