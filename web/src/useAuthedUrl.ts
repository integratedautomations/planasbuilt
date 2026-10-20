import { useEffect, useState } from 'react'
import { fetchBlob } from './api'

/**
 * An object URL for a file that needs the login token. `<img>` / `<a>` cannot send headers, and the
 * token must not travel in URLs, so the bytes are fetched with an Authorization header and shown from a blob.
 * `blob:` / `data:` sources pass through unchanged. Returns '' until loaded. The object URL is revoked on change/unmount.
 */
export function useAuthedUrl(src: string | undefined): string {
  const direct = !src || src.startsWith('blob:') || src.startsWith('data:')
  const [loaded, setLoaded] = useState<{ src: string; url: string } | null>(null)
  useEffect(() => {
    if (direct || !src) return
    let cancelled = false
    let made = ''
    fetchBlob(src).then(b => {
      made = URL.createObjectURL(b)
      if (cancelled) { URL.revokeObjectURL(made); return }
      setLoaded({ src, url: made })
    }).catch(() => { if (!cancelled) setLoaded(null) })
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made) }
  }, [src, direct])
  if (direct) return src ?? ''
  return loaded?.src === src ? loaded.url : ''
}
