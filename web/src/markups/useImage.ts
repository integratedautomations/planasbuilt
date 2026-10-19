import { useEffect, useState } from 'react'

const cache = new Map<string, HTMLImageElement>()

/** Loads an image (symbol icons are data URLs) once and shares it between markups. */
export function useImage(src: string | undefined) {
  const [img, setImg] = useState<HTMLImageElement | null>(() => (src && cache.get(src)?.complete ? cache.get(src)! : null))
  useEffect(() => {
    if (!src) { setImg(null); return }
    let el = cache.get(src)
    if (!el) {
      el = new Image()
      el.src = src
      cache.set(src, el)
    }
    if (el.complete && el.naturalWidth) { setImg(el); return }
    const done = () => setImg(el!)
    el.addEventListener('load', done)
    return () => el!.removeEventListener('load', done)
  }, [src])
  return img
}
