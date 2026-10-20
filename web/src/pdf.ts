import * as pdfjs from 'pdfjs-dist'
// Wrapper worker loads our polyfills before pdf.js (older iPadOS)
pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL('./pdfWorker.ts', import.meta.url), { type: 'module' })

export type PDFDocumentProxy = pdfjs.PDFDocumentProxy
export type PDFPageProxy = pdfjs.PDFPageProxy

/** Returns the loading task; call task.destroy() to free the document and its worker data. */
export function loadPdf(src: string | ArrayBuffer) {
  return pdfjs.getDocument(typeof src === 'string' ? { url: src } : { data: src })
}

// Browsers fail on very large canvases. iOS/iPadOS (every browser there is WebKit) kills the
// whole tab when canvas memory runs out, so keep it much smaller there.
const IS_IOS = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
export const MAX_CANVAS_PIXELS = IS_IOS ? 6_000_000 : 16_000_000

export function clampRenderScale(page: PDFPageProxy, wanted: number) {
  const vp = page.getViewport({ scale: 1 })
  const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height))
  return Math.min(wanted, maxScale)
}
