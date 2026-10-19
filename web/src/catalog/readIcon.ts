/** Reads an uploaded icon as a data URL; raster images are shrunk to 128px so they stay small. */
export async function readIcon(file: File): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  if (file.type === 'image/svg+xml') return url
  return shrinkImage(url)
}

/** Redraws an image data URL at most 128px on its long side, as PNG. */
export async function shrinkImage(url: string): Promise<string> {
  const img = new Image()
  img.src = url
  await img.decode()
  const scale = Math.min(1, 128 / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.width * scale))
  c.height = Math.max(1, Math.round(img.height * scale))
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}
