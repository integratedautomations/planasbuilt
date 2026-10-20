import { loadPdf } from '../pdf'
import type { PDFDocumentProxy } from '../pdf'
import type { Bounds } from './revu'

/** Renders the region of a page (display space, scale 1) as a PNG data URL, at most `max` pixels on the long side. */
export async function cropPage(pdf: PDFDocumentProxy, pageNumber: number, region: Bounds, max = 96, pad = 3): Promise<string> {
  const page = await pdf.getPage(pageNumber)
  const x = region[0] - pad, y = region[1] - pad
  const w = Math.max(4, region[2] - region[0] + pad * 2), h = Math.max(4, region[3] - region[1] + pad * 2)
  const scale = Math.min(8, max / Math.max(w, h))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -x * scale, -y * scale] }).promise
  return canvas.toDataURL('image/png')
}

/** Opens PDF bytes for cropping; call destroy() when done. */
export function openForCrops(bytes: ArrayBuffer) {
  const task = loadPdf(bytes)
  return { promise: task.promise, destroy: () => { void task.destroy() } }
}
