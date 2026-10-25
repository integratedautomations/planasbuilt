import { useEffect } from 'react'
import type { RefObject } from 'react'

/** Keeps the active tab of a horizontally scrolling tab strip visible (phones): scrolls the strip, not the page, whenever `dep` changes. */
export function useActiveTabIntoView(ref: RefObject<HTMLElement | null>, dep: unknown, selector = '.active, [aria-current="page"]') {
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(selector)
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [ref, dep, selector])
}
