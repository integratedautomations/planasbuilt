import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { MarkupCanvas } from '../markups/MarkupCanvas'
import { areaPathIn, buildAreaIndex, isArea } from '../markups/areas'
import { detectStacks } from '../markups/stacks'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup, SymbolSet } from '../markups/types'
import { useCatalogContext } from '../catalog/useCatalog'
import { clampRenderScale } from '../pdf'
import type { PDFDocumentProxy, PDFPageProxy } from '../pdf'
import { usePanZoom } from '../viewer/usePanZoom'
import type { View } from '../viewer/usePanZoom'
import { tintInk } from './pixelDiff'

export interface PaneHandle {
  setView: (v: View) => void
  view: () => View
  centerOn: (x: number, y: number, zoom?: number) => void
  fit: () => void
  size: () => { width: number; height: number }
}

interface Props {
  /** Page to show; the pane clamps it to the PDF's page count. */
  pdf: PDFDocumentProxy | null
  pageNum: number
  /** Overlay mode: this PDF is drawn tinted blue over `pdf` (tinted red), multiplied. */
  overlayPdf?: PDFDocumentProxy | null
  overlayOpacity?: number
  markups: Markup[]
  symbolSets: Map<string, SymbolSet>
  /** Called on every pan/zoom, for keeping a second pane in step. */
  onView?: (v: View) => void
  caption?: string
}

const noop = () => {}
const noopRef = { current: false }
const noBase = { document_id: '', page: 1, layer_id: null, style: DEFAULT_STYLE, stampText: '', symbolSetId: null }

/** One read-only plan view: PDF page bitmap plus markups, with its own pan and zoom. */
export const ComparePane = forwardRef<PaneHandle, Props>(function ComparePane(
  { pdf, pageNum, overlayPdf, overlayOpacity = 0.8, markups, symbolSets, onView, caption }, ref) {
  const catalog = useCatalogContext()
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const markupRef = useRef<{ stage: () => import('konva').default.Stage | null }>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const onViewRef = useRef(onView)
  onViewRef.current = onView

  const n = pdf ? Math.min(Math.max(1, pageNum), pdf.numPages) : 0
  useEffect(() => {
    if (!pdf) { setPage(null); return }
    let cancelled = false
    let got: PDFPageProxy | null = null
    pdf.getPage(n).then(p => { got = p; if (!cancelled) setPage(p) })
    return () => { cancelled = true; got?.cleanup() } // pdf.js defers this while a render is running
  }, [pdf, n])

  // Release the visible bitmap when the pane goes away (matters on iOS).
  useEffect(() => () => { const c = canvasRef.current; if (c) c.width = c.height = 0 }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pageSize = page ? page.getViewport({ scale: 1 }) : null
  const { settledZoom, fit, centerOn, view, setView } = usePanZoom(viewportRef, stageRef,
    pageSize ? { width: pageSize.width, height: pageSize.height } : null, {
      onView: v => {
        const stage = markupRef.current?.stage()
        if (stage) { stage.position({ x: v.x, y: v.y }); stage.scale({ x: v.zoom, y: v.zoom }); stage.batchDraw() }
        onViewRef.current?.(v)
      },
    })
  useEffect(() => {
    const stage = markupRef.current?.stage()
    if (stage) { const v = view.current; stage.position({ x: v.x, y: v.y }); stage.scale({ x: v.zoom, y: v.zoom }); stage.batchDraw() }
  })
  useImperativeHandle(ref, () => ({
    setView, view: () => view.current, centerOn, fit, size: () => ({ width: viewportRef.current?.clientWidth ?? 0, height: viewportRef.current?.clientHeight ?? 0 }),
  }), [setView, view, centerOn, fit])

  // Page bitmap, re-rendered when zoom settles. Overlay mode composites two tinted renders with multiply.
  const [overlayPage, setOverlayPage] = useState<PDFPageProxy | null>(null)
  useEffect(() => {
    if (!overlayPdf) { setOverlayPage(null); return }
    let cancelled = false
    let got: PDFPageProxy | null = null
    overlayPdf.getPage(Math.min(Math.max(1, pageNum), overlayPdf.numPages)).then(p => { got = p; if (!cancelled) setOverlayPage(p) })
    return () => { cancelled = true; got?.cleanup() }
  }, [overlayPdf, pageNum])

  useEffect(() => {
    if (!page || !canvasRef.current) return
    const scale = clampRenderScale(page, settledZoom * (window.devicePixelRatio || 1))
    const vp = page.getViewport({ scale })
    const w = Math.floor(vp.width), h = Math.floor(vp.height)
    const tasks: { cancel: () => void }[] = []
    const temps: HTMLCanvasElement[] = []
    let cancelled = false
    const draw = async (p: PDFPageProxy, fitWidth: number) => {
      if (cancelled) throw new Error('cancelled')
      const own = p.getViewport({ scale: 1 })
      const v = p.getViewport({ scale: scale * (fitWidth / own.width) })
      const c = document.createElement('canvas')
      temps.push(c)
      c.width = w; c.height = h
      const task = p.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: v })
      tasks.push(task)
      await task.promise
      return c
    }
    ;(async () => {
      const base = await draw(page, page.getViewport({ scale: 1 }).width)
      const top = overlayPage ? await draw(overlayPage, page.getViewport({ scale: 1 }).width) : null
      if (top) {
        for (const [c, tint] of [[base, 'red'], [top, 'cyan']] as const) {
          const ctx = c.getContext('2d')!
          const img = ctx.getImageData(0, 0, w, h)
          tintInk(img.data, tint)
          ctx.putImageData(img, 0, 0)
        }
      }
      const c = canvasRef.current
      if (!c) return
      c.width = w; c.height = h
      const ctx = c.getContext('2d')!
      if (top) { // composite straight into the visible canvas, no third offscreen canvas
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
        ctx.drawImage(base, 0, 0)
        ctx.globalCompositeOperation = 'multiply'
        ctx.globalAlpha = overlayOpacity
        ctx.drawImage(top, 0, 0)
      } else {
        ctx.drawImage(base, 0, 0)
      }
    })().catch(() => { /* cancelled */ }).finally(() => {
      for (const t of temps) t.width = t.height = 0 // release the offscreen bitmaps now rather than at GC
      page.cleanup()
      overlayPage?.cleanup()
    })
    return () => { cancelled = true; tasks.forEach(t => t.cancel()) }
  }, [page, overlayPage, overlayOpacity, settledZoom])

  const pageMarkups = useMemo(() => markups.filter(m => m.page === n), [markups, n])
  const areaIndex = useMemo(() => buildAreaIndex(markups.filter(isArea)), [markups])
  const areaPaths = useMemo(() => new Map([...areaIndex.byId.values()].filter(a => a.page === n).map(a => [a.id, areaPathIn(areaIndex, a)])), [areaIndex, n])
  const stacks = useMemo(() => detectStacks(pageMarkups), [pageMarkups])
  const lockedIds = useMemo(() => new Set<string>(), [])

  return (
    <div className="compare-pane">
      {caption && <div className="compare-caption">{caption}</div>}
      <div className="viewport tool-pan" ref={viewportRef} onContextMenu={e => e.preventDefault()}>
        {!page && <div className="center muted">Loading…</div>}
        <div className="stage" ref={stageRef} style={pageSize ? { width: pageSize.width, height: pageSize.height } : { display: 'none' }}>
          <canvas ref={canvasRef} className="page-canvas" />
        </div>
        {page && size.width > 0 && (
          <MarkupCanvas ref={markupRef as any} width={size.width} height={size.height} zoom={settledZoom}
            markups={pageMarkups} areaPaths={areaPaths} lockedIds={lockedIds} tool="pan" symbolSets={symbolSets} catalog={catalog}
            readOnly selectedIds={[]} onSelect={noop} commit={noop} consumedRef={noopRef} scale={null} onCalibrate={noop} calLine={null}
            boxSelect={false} multiSelect={false} showCones stacks={stacks} newBase={{ ...noBase, page: n }} />
        )}
      </div>
    </div>
  )
})
