import imageCompression from 'browser-image-compression'
import { loadCompany } from '../settings/company'

export interface Compressed { blob: Blob; width: number; height: number }

/** JPEG, max long side from the company setting (2000px by default), ~0.8 quality, aiming for <= 1 MB. EXIF orientation is applied by the library. */
export async function compressPhoto(file: File): Promise<Compressed> {
  const max = (await loadCompany().catch(() => null))?.photo_max_dimension ?? 2000
  const out = await imageCompression(file, {
    maxWidthOrHeight: max,
    maxSizeMB: 1,
    initialQuality: 0.8,
    fileType: 'image/jpeg',
    useWebWorker: true,
    preserveExif: false,
  })
  const { width, height } = await imageSize(out)
  return { blob: out, width, height }
}

export function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')) }
    img.src = url
  })
}
