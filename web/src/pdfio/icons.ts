import type { SymbolSet } from '../markups/types'

/** Rasterizes a symbol icon (SVG or image data URL) to PNG bytes; null if the browser can't. */
export async function iconToPng(src: string, size = 128): Promise<Uint8Array | null> {
  if (!src) return null
  try {
    const img = new Image()
    img.decoding = 'async'
    img.width = size; img.height = size
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('icon')); img.src = src })
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, size, size)
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  } catch { return null }
}

export async function loadIcons(sets: Iterable<SymbolSet>): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const s of sets) {
    const png = await iconToPng(s.icon)
    if (png) out.set(s.id, png)
  }
  return out
}
