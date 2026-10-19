/** Saves bytes as a file download. */
export function downloadBytes(bytes: Uint8Array, filename: string, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
