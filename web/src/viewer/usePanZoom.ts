import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface View { x: number; y: number; zoom: number }
export interface Size { width: number; height: number }

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 20

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** Zoom around a screen point (relative to the viewport) so that point stays fixed. */
export function zoomAround(view: View, factor: number, px: number, py: number): View {
  const zoom = clampZoom(view.zoom * factor)
  const k = zoom / view.zoom
  return { zoom, x: px - (px - view.x) * k, y: py - (py - view.y) * k }
}

export function fitView(page: Size, box: Size, margin = 16): View {
  const zoom = clampZoom(Math.min((box.width - margin * 2) / page.width, (box.height - margin * 2) / page.height))
  return { zoom, x: (box.width - page.width * zoom) / 2, y: (box.height - page.height * zoom) / 2 }
}

export interface PanZoomOptions {
  /** Called at pointerdown (after the markup layer saw it): false = a tool owns this pointer. */
  shouldPan?: (e: PointerEvent) => boolean
  /** A second finger arrived: tools should cancel whatever they were drawing. */
  onPinchStart?: () => void
  /** Every view change, for layers that position themselves (the markup stage). */
  onView?: (v: View) => void
}

/**
 * Pan (drag / one finger), wheel zoom around the cursor, and two-finger pinch.
 * The stage transform is written straight to the DOM for smooth 60fps; React state
 * only tracks the zoom label and a debounced "settled" zoom used to re-render the bitmap.
 */
export function usePanZoom(
  viewportRef: RefObject<HTMLDivElement | null>,
  stageRef: RefObject<HTMLDivElement | null>,
  page: Size | null,
  options: PanZoomOptions = {},
) {
  const view = useRef<View>({ x: 0, y: 0, zoom: 1 })
  const [zoom, setZoom] = useState(1)
  const [settledZoom, setSettledZoom] = useState(1)
  const settleTimer = useRef<number | undefined>(undefined)
  const opts = useRef(options)
  opts.current = options

  const apply = useCallback((v: View) => {
    view.current = v
    if (stageRef.current) stageRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
    opts.current.onView?.(v)
    setZoom(v.zoom)
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => setSettledZoom(v.zoom), 180)
  }, [stageRef])

  const fit = useCallback(() => {
    const el = viewportRef.current
    if (el && page) apply(fitView(page, { width: el.clientWidth, height: el.clientHeight }))
  }, [apply, page, viewportRef])

  const zoomBy = useCallback((factor: number) => {
    const el = viewportRef.current
    if (el) apply(zoomAround(view.current, factor, el.clientWidth / 2, el.clientHeight / 2))
  }, [apply, viewportRef])

  /** Centers the given page-space point at the given zoom. */
  const centerOn = useCallback((px: number, py: number, z?: number) => {
    const el = viewportRef.current
    if (!el) return
    const zoom = clampZoom(z ?? view.current.zoom)
    apply({ zoom, x: el.clientWidth / 2 - px * zoom, y: el.clientHeight / 2 - py * zoom })
  }, [apply, viewportRef])

  // Fit when a new page (size) arrives
  const pageKey = page ? `${page.width}x${page.height}` : ''
  useEffect(() => { if (pageKey) fit() }, [pageKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const pointers = new Map<number, { x: number; y: number; pan: boolean }>()
    let pinch: { dist: number; mid: { x: number; y: number } } | null = null

    const local = (e: PointerEvent | MouseEvent) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const pinchState = () => {
      const [a, b] = [...pointers.values()]
      return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = local(e)
      // Trackpad two-finger scroll pans; mouse wheel and pinch (ctrl) zoom like Revu
      if (!e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0) {
        apply({ ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY })
        return
      }
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      apply(zoomAround(view.current, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y))
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return
      // Floating controls (selection bar) own their own pointers
      if ((e.target as Element | null)?.closest?.('[data-no-pan]')) return
      const middle = e.button === 1
      const pan = middle || (opts.current.shouldPan?.(e) ?? true)
      pointers.set(e.pointerId, { ...local(e), pan })
      if (pointers.size === 2) {
        pinch = pinchState()
        opts.current.onPinchStart?.()
      }
      if (pan || pointers.size === 2) {
        if (middle) e.preventDefault()
        el.setPointerCapture(e.pointerId)
        el.classList.add('panning')
      }
    }
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      const p = { ...local(e), pan: prev.pan }
      pointers.set(e.pointerId, p)
      if (pointers.size === 1 && prev.pan) {
        apply({ ...view.current, x: view.current.x + p.x - prev.x, y: view.current.y + p.y - prev.y })
      } else if (pointers.size === 2 && pinch) {
        const next = pinchState()
        const panned = { ...view.current, x: view.current.x + next.mid.x - pinch.mid.x, y: view.current.y + next.mid.y - pinch.mid.y }
        apply(zoomAround(panned, next.dist / pinch.dist, next.mid.x, next.mid.y))
        pinch = next
      }
    }
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      pinch = pointers.size === 2 ? pinchState() : null
      if (pointers.size === 0) el.classList.remove('panning')
    }

    // Middle button: no browser autoscroll / paste-on-Linux, whatever the page does with the press
    const onMouseDown = (e: MouseEvent) => { if (e.button === 1) e.preventDefault() }

    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [apply, viewportRef])

  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  return { zoom, settledZoom, fit, zoomBy, centerOn, view }
}
