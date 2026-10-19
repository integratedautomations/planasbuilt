import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, documentFileUrl } from '../api'
import { clampRenderScale, loadPdf, PDFDocumentProxy, PDFPageProxy } from '../pdf'
import { Thumbnails } from '../viewer/Thumbnails'
import { usePanZoom } from '../viewer/usePanZoom'

interface DocMeta { id: string; name: string; revisions: { revision: number; page_count: number }[] }

export function ViewerPage() {
  const { projectId, documentId } = useParams()
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageNum, setPageNum] = useState(1)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [error, setError] = useState('')
  const [showThumbs, setShowThumbs] = useState(() => window.innerWidth >= 900)

  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const pageSize = page ? page.getViewport({ scale: 1 }) : null
  const { zoom, settledZoom, fit, zoomBy } = usePanZoom(viewportRef, stageRef,
    pageSize ? { width: pageSize.width, height: pageSize.height } : null)

  useEffect(() => {
    api<DocMeta>(`/documents/${documentId}`).then(setMeta).catch(e => setError(e.message))
    let cancelled = false
    const task = loadPdf(documentFileUrl(documentId!))
    task.promise.then(setPdf).catch(e => { if (!cancelled) setError(`Could not open PDF: ${e.message}`) })
    return () => { cancelled = true; task.destroy() }
  }, [documentId])

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    pdf.getPage(pageNum).then(p => { if (!cancelled) setPage(p) })
    return () => { cancelled = true }
  }, [pdf, pageNum])

  // Re-render the page bitmap whenever zoom settles, into an offscreen canvas then swap,
  // so the visible page never flashes blank.
  useEffect(() => {
    if (!page || !canvasRef.current) return
    const scale = clampRenderScale(page, settledZoom * (window.devicePixelRatio || 1))
    const vp = page.getViewport({ scale })
    const off = document.createElement('canvas')
    off.width = Math.floor(vp.width)
    off.height = Math.floor(vp.height)
    const task = page.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport: vp })
    task.promise.then(() => {
      const c = canvasRef.current
      if (!c) return
      c.width = off.width
      c.height = off.height
      c.getContext('2d')!.drawImage(off, 0, 0)
    }).catch(() => { /* cancelled */ })
    return () => task.cancel()
  }, [page, settledZoom])

  const pageCount = pdf?.numPages ?? meta?.revisions[0]?.page_count ?? 0
  const goTo = useCallback((n: number) => setPageNum(p => Math.min(Math.max(1, n), pageCount || p)), [pageCount])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === 'PageDown' || e.key === 'ArrowRight') goTo(pageNum + 1)
      else if (e.key === 'PageUp' || e.key === 'ArrowLeft') goTo(pageNum - 1)
      else if (e.key === '+' || e.key === '=') zoomBy(1.25)
      else if (e.key === '-') zoomBy(0.8)
      else if (e.key === '0') fit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pageNum, goTo, zoomBy, fit])

  return (
    <div className="viewer">
      <header className="topbar toolbar">
        <Link to={`/projects/${projectId}`} className="icon-btn" title="Back to plans">←</Link>
        <button className="icon-btn" title="Pages" onClick={() => setShowThumbs(s => !s)}>☰</button>
        <span className="crumb ellipsis">{meta?.name ?? '…'}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => goTo(pageNum - 1)} disabled={pageNum <= 1} title="Previous page">‹</button>
        <span className="page-indicator">
          <input className="page-input" inputMode="numeric" value={pageNum}
            onChange={e => { const n = parseInt(e.target.value, 10); if (n) goTo(n) }} aria-label="Page number" />
          <span className="muted">/ {pageCount || '…'}</span>
        </span>
        <button className="icon-btn" onClick={() => goTo(pageNum + 1)} disabled={pageNum >= pageCount} title="Next page">›</button>
        <span className="divider hide-sm" />
        <button className="icon-btn hide-sm" onClick={() => zoomBy(0.8)} title="Zoom out">−</button>
        <button className="zoom-label" onClick={fit} title="Fit page (0)">{Math.round(zoom * 100)}%</button>
        <button className="icon-btn hide-sm" onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
      </header>
      <div className="viewer-body">
        {showThumbs && pdf && (
          <Thumbnails pdf={pdf} current={pageNum}
            onSelect={n => { goTo(n); if (window.innerWidth < 900) setShowThumbs(false) }} />
        )}
        <div className="viewport" ref={viewportRef}>
          {error && <div className="error floating">{error}</div>}
          {!page && !error && <div className="center muted">Loading plan…</div>}
          <div className="stage" ref={stageRef}
            style={pageSize ? { width: pageSize.width, height: pageSize.height } : { display: 'none' }}>
            <canvas ref={canvasRef} className="page-canvas" />
            {/* Markup layer (Milestone 2) mounts here, in PDF point coordinates */}
          </div>
        </div>
      </div>
    </div>
  )
}
