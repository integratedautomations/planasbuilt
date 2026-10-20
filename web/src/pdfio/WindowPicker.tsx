import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { View } from '../viewer/usePanZoom'
import { windowFromCorners } from './printPlan'
import type { PrintWindow } from './printPlan'

interface Props {
  page: number
  pageSize: { width: number; height: number }
  view: RefObject<View>
  /** The chosen window, or null when cancelled (Esc, or a drag too small to count). */
  onDone: (w: PrintWindow | null) => void
}

/** Full-viewport crosshair overlay: drag a rectangle on the page. Esc cancels. */
export function WindowPicker({ page, pageSize, view, onDone }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(null) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDone])
  const local = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const toPage = (p: { x: number; y: number }) => { const v = view.current; return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom } }
  return (
    <div ref={ref} data-no-pan className="window-picker" style={{ position: 'absolute', inset: 0, zIndex: 8, cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={e => { if (e.button !== 0) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); const p = local(e); setDrag({ a: p, b: p }) }}
      onPointerMove={e => { if (drag) setDrag({ ...drag, b: local(e) }) }}
      onPointerUp={e => {
        if (!drag) return
        const w = windowFromCorners(page, toPage(drag.a), toPage(local(e)), pageSize)
        setDrag(null)
        onDone(w)
      }}
      onContextMenu={e => e.preventDefault()}>
      <div className="tool-hint">Drag to choose the print window. Esc cancels.</div>
      {drag && (
        <div style={{ position: 'absolute', left: Math.min(drag.a.x, drag.b.x), top: Math.min(drag.a.y, drag.b.y), width: Math.abs(drag.a.x - drag.b.x), height: Math.abs(drag.a.y - drag.b.y),
          border: '2px dashed #1971c2', background: 'rgb(25 113 194 / 0.15)', pointerEvents: 'none' }} />
      )}
    </div>
  )
}
