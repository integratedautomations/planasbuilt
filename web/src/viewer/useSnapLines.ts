import { useEffect, useState } from 'react'
import type { PDFPageProxy } from '../pdf'
import { loadPageLines } from '../pdf/pageLines'
import { SegIndex } from '../markups/snap'

/**
 * Spatial index of the PDF page's vector lines for snapping, or null while loading / off / for scanned pages.
 * `key` identifies the page content (document + revision + page number). Starts after the page has had time to paint.
 */
export function usePageLines(page: PDFPageProxy | null, key: string, enabled: boolean): SegIndex | null {
  const [state, setState] = useState<{ key: string; index: SegIndex } | null>(null)
  useEffect(() => {
    if (!page || !enabled) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      loadPageLines(page, key, () => cancelled).then(segs => {
        if (!cancelled && segs) setState({ key, index: SegIndex.fromSegments(segs) })
      }).catch(() => { /* no snap lines for this page */ })
    }, 400)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [page, key, enabled])
  return enabled && state?.key === key ? state.index : null
}
