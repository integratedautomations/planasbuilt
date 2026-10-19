import { RefObject, useCallback, useEffect, useRef, useState } from 'react'

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

/**
 * Pan (drag / one finger), wheel zoom around the cursor, and two-finger pinch.
 * The stage transform is written straight to the DOM for smooth 60fps; React state
 * only tracks the zoom label and a debounced "settled" zoom used to re-render the bitmap.
 */
export function usePanZoom(viewportRef: RefObject<HTMLDivElement | null>, stageRef: RefObject<HTMLDivElement | null>, page: Size | null) {
  const view = useRef<View>({ x: 0, y: 0, zoom: 1 })
  const [zoom, setZoom] = useState(1)
  const [settledZoom, setSettledZoom] = useState(1)
  const settleTimer = useRef<number | undefined>(undefined)

  const apply = useCallback((v: View) => {
    view.current = v
    if (stageRef.current) stageRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
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

  // Fit when a new page (size) arrives
  const pageKey = page ? `${page.width}x${page.height}` : ''
  useEffect(() => { if (pageKey) fit() }, [pageKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const pointers = new Map<number, { x: number; y: number }>()
    let pinch: { dist: number; mid: { x: number; y: number } } | null = null

    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const pinchState = () => {
      const [a, b] = [...pointers.values()]
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = local(e)
      // Trackpad pan (no ctrl) with small deltas on both axes; everything else zooms like Revu
      if (!e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0) {
        apply({ ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY })
        return
      }
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      apply(zoomAround(view.current, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y))
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return
      el.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, local(e))
      if (pointers.size === 2) pinch = pinchState()
      el.classList.add('panning')
    }
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      const p = local(e)
      pointers.set(e.pointerId, p)
      if (pointers.size === 1) {
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
    const onDouble = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      apply(zoomAround(view.current, 2, e.clientX - r.left, e.clientY - r.top))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('dblclick', onDouble)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('dblclick', onDouble)
    }
  }, [apply, viewportRef])

  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  return { zoom, settledZoom, fit, zoomBy, view }
}
