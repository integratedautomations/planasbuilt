import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, documentFileUrl, post } from '../api'
import type { Project } from '../api'
import { clampRenderScale, loadPdf } from '../pdf'
import type { PDFDocumentProxy, PDFPageProxy } from '../pdf'
import { Thumbnails } from '../viewer/Thumbnails'
import { usePanZoom } from '../viewer/usePanZoom'
import type { View } from '../viewer/usePanZoom'
import { MarkupCanvas } from '../markups/MarkupCanvas'
import type { MarkupCanvasHandle } from '../markups/MarkupCanvas'
import { ToolRail, TOOLS } from '../markups/ToolRail'
import { SidePanel } from '../markups/SidePanel'
import { useMarkups } from '../markups/useMarkups'
import { DEFAULT_STYLE, defaultStyleFor } from '../markups/types'
import type { Layer, Markup, MarkupStyle, MarkupType, Tool } from '../markups/types'
import { uuid } from '../uuid'

interface DocMeta { id: string; name: string; revisions: { revision: number; page_count: number }[] }

/** Per-viewer layer visibility/lock, remembered per project in this browser. */
function useLayerFlags(projectId: string, kind: 'hidden' | 'locked') {
  const key = `planmark.${kind}.${projectId}`
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')) } catch { return new Set() }
  })
  const toggle = (id: string) => setSet(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    try { localStorage.setItem(key, JSON.stringify([...next])) } catch { /* ignore */ }
    return next
  })
  return [set, toggle] as const
}

export function ViewerPage() {
  const { projectId, documentId } = useParams() as { projectId: string; documentId: string }
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageNum, setPageNum] = useState(1)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [error, setError] = useState('')
  const [showThumbs, setShowThumbs] = useState(() => window.innerWidth >= 900)
  const [showPanel, setShowPanel] = useState(() => window.innerWidth >= 900)

  const [tool, setTool] = useState<Tool>('select')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [defaultStyle, setDefaultStyle] = useState<MarkupStyle>(DEFAULT_STYLE)
  const [stampText, setStampText] = useState('APPROVED')
  const [layers, setLayers] = useState<Layer[]>([])
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null)
  const [hidden, toggleHidden] = useLayerFlags(projectId, 'hidden')
  const [locked, toggleLocked] = useLayerFlags(projectId, 'locked')
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const markupRef = useRef<MarkupCanvasHandle>(null)
  const consumedRef = useRef(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const clipboard = useRef<Markup[]>([])

  const store = useMarkups(documentId)
  const readOnly = project?.role === 'viewer'
  const activeTool: Tool = spaceHeld ? 'pan' : tool

  const syncStage = useCallback((v: View) => {
    const stage = markupRef.current?.stage()
    if (!stage) return
    stage.position({ x: v.x, y: v.y })
    stage.scale({ x: v.zoom, y: v.zoom })
    stage.batchDraw()
  }, [])

  const pageSize = page ? page.getViewport({ scale: 1 }) : null
  const { zoom, settledZoom, fit, zoomBy, view } = usePanZoom(viewportRef, stageRef,
    pageSize ? { width: pageSize.width, height: pageSize.height } : null, {
      shouldPan: () => { const owned = consumedRef.current; consumedRef.current = false; return !owned },
      onPinchStart: () => markupRef.current?.cancelDraft(),
      onView: syncStage,
    })
  useEffect(() => { syncStage(view.current) })

  useEffect(() => {
    api<DocMeta>(`/documents/${documentId}`).then(setMeta).catch(e => setError(e.message))
    api<Project>(`/projects/${projectId}`).then(setProject).catch(() => {})
    api<Layer[]>(`/projects/${projectId}/layers`).then(setLayers).catch(() => {})
    let cancelled = false
    const task = loadPdf(documentFileUrl(documentId))
    task.promise.then(setPdf).catch(e => { if (!cancelled) setError(`Could not open PDF: ${e.message}`) })
    return () => { cancelled = true; task.destroy() }
  }, [documentId, projectId])

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    pdf.getPage(pageNum).then(p => { if (!cancelled) setPage(p) })
    setSelectedIds([])
    return () => { cancelled = true }
  }, [pdf, pageNum])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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

  const pageMarkups = useMemo(
    () => [...store.markups.values()].filter(m => m.page === pageNum && !hidden.has(m.layer_id ?? '')),
    [store.markups, pageNum, hidden])
  const selected = useMemo(
    () => selectedIds.map(id => store.markups.get(id)).filter((m): m is Markup => !!m),
    [selectedIds, store.markups])

  const pageCount = pdf?.numPages ?? meta?.revisions[0]?.page_count ?? 0
  const goTo = useCallback((n: number) => setPageNum(p => Math.min(Math.max(1, n), pageCount || p)), [pageCount])

  const deleteSelected = useCallback(() => {
    if (readOnly) return
    store.commit(selected.map(m => ({ before: m, after: null })))
    setSelectedIds([])
  }, [readOnly, selected, store])

  const updateSelected = useCallback((patch: (m: Markup) => Markup, mergeKey: string) => {
    if (readOnly) return
    store.commit(selected.map(m => ({ before: m, after: patch(m) })), `${mergeKey}:${selectedIds.join(',')}`)
  }, [readOnly, selected, selectedIds, store])

  const paste = useCallback(() => {
    if (readOnly || !clipboard.current.length) return
    const copies = clipboard.current.map(m => ({
      ...m, id: uuid(), page: pageNum,
      geometry: { ...m.geometry, x: m.geometry.x + 20, y: m.geometry.y + 20 },
    }))
    clipboard.current = copies // paste again cascades
    store.commit(copies.map(m => ({ before: null, after: m })))
    setSelectedIds(copies.map(m => m.id))
  }, [pageNum, readOnly, store])

  const chooseTool = useCallback((t: Tool) => {
    setTool(t)
    if (t !== 'select' && t !== 'pan') {
      setSelectedIds([])
      setDefaultStyle(s => defaultStyleFor(t as MarkupType, { ...DEFAULT_STYLE, stroke: s.stroke || DEFAULT_STYLE.stroke, strokeWidth: s.strokeWidth }))
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); setSelectedIds([]) }
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); setSelectedIds([]) }
      else if (mod && k === 'c') clipboard.current = selected.map(m => structuredClone(m))
      else if (mod && k === 'v') { e.preventDefault(); paste() }
      else if (mod && k === 'a') { e.preventDefault(); setSelectedIds(pageMarkups.filter(m => !locked.has(m.layer_id ?? '')).map(m => m.id)) }
      else if (mod) return
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
      else if (e.key === 'Escape') { markupRef.current?.cancelDraft(); setSelectedIds([]); setTool('select') }
      else if (e.key === 'Enter') markupRef.current?.finishDraft()
      else if (e.key === ' ' && !e.repeat) { e.preventDefault(); setSpaceHeld(true) }
      else if (e.key === 'PageDown') goTo(pageNum + 1)
      else if (e.key === 'PageUp') goTo(pageNum - 1)
      else if (e.key === '+' || e.key === '=') zoomBy(1.25)
      else if (e.key === '-') zoomBy(0.8)
      else if (e.key === '0') fit()
      else {
        const t = TOOLS.find(t => t.key.toLowerCase() === k)
        if (t && (!readOnly || t.tool === 'select' || t.tool === 'pan')) chooseTool(t.tool)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') setSpaceHeld(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp) }
  }, [pageNum, goTo, zoomBy, fit, store, selected, paste, deleteSelected, pageMarkups, locked, readOnly, chooseTool])

  async function addLayer(name: string) {
    const layer = await post<Layer>(`/projects/${projectId}/layers`, { name })
    setLayers(ls => [...ls, layer])
    setActiveLayerId(layer.id)
  }

  return (
    <div className="viewer">
      <header className="topbar toolbar">
        <Link to={`/projects/${projectId}`} className="icon-btn" title="Back to plans">←</Link>
        <button className="icon-btn" title="Pages" onClick={() => setShowThumbs(s => !s)}>☰</button>
        <span className="crumb ellipsis">{meta?.name ?? '…'}</span>
        <span className={`save-state${store.saveError ? ' bad' : ''}`} title={store.saveError}>
          {store.saveError ? 'Not saved' : store.saving ? 'Saving…' : store.loaded ? 'Saved' : ''}
        </span>
        <span className="spacer" />
        {!readOnly && (
          <>
            <button className="icon-btn" onClick={() => { store.undo(); setSelectedIds([]) }} disabled={!store.canUndo} title="Undo (Ctrl+Z)">↶</button>
            <button className="icon-btn" onClick={() => { store.redo(); setSelectedIds([]) }} disabled={!store.canRedo} title="Redo (Ctrl+Y)">↷</button>
            <span className="divider hide-sm" />
          </>
        )}
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
        <button className={`icon-btn${showPanel ? ' active' : ''}`} title="Properties & layers" onClick={() => setShowPanel(s => !s)}>⚙</button>
      </header>
      <div className="viewer-body">
        {showThumbs && pdf && (
          <Thumbnails pdf={pdf} current={pageNum}
            onSelect={n => { goTo(n); if (window.innerWidth < 900) setShowThumbs(false) }} />
        )}
        <ToolRail tool={activeTool} onTool={chooseTool} readOnly={readOnly} />
        <div className={`viewport tool-${activeTool}`} ref={viewportRef}>
          {error && <div className="error floating">{error}</div>}
          {!page && !error && <div className="center muted">Loading plan…</div>}
          <div className="stage" ref={stageRef}
            style={pageSize ? { width: pageSize.width, height: pageSize.height } : { display: 'none' }}>
            <canvas ref={canvasRef} className="page-canvas" />
          </div>
          {page && viewportSize.width > 0 && (
            <MarkupCanvas ref={markupRef} width={viewportSize.width} height={viewportSize.height}
              zoom={settledZoom} markups={pageMarkups} lockedLayerIds={locked} tool={activeTool}
              readOnly={readOnly} selectedIds={selectedIds} onSelect={setSelectedIds} commit={store.commit}
              consumedRef={consumedRef}
              newBase={{ document_id: documentId, page: pageNum, layer_id: activeLayerId, style: defaultStyle, stampText }}
              onCreated={m => { if (m.type === 'text') { setShowPanel(true); setTool('select'); setTimeout(() => textRef.current?.select(), 50) } }} />
          )}
        </div>
        {showPanel && (
          <SidePanel selected={selected} readOnly={readOnly} defaultStyle={defaultStyle} onDefaultStyle={setDefaultStyle}
            stampText={stampText} onStampText={setStampText} onUpdate={updateSelected} onDelete={deleteSelected}
            layers={layers} activeLayerId={activeLayerId} onActiveLayer={setActiveLayerId}
            hidden={hidden} locked={locked} onToggleHidden={toggleHidden} onToggleLocked={toggleLocked}
            onAddLayer={addLayer} textRef={textRef} />
        )}
      </div>
    </div>
  )
}
