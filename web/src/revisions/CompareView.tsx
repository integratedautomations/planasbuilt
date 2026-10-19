import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SymbolSet } from '../markups/types'
import { loadPdf } from '../pdf'
import type { PDFDocumentProxy } from '../pdf'
import { fetchRevisionPdf, revisionName } from './api'
import type { RevisionDetail } from './api'
import { ComparePane } from './ComparePane'
import type { PaneHandle } from './ComparePane'
import { changeEntries, diffMarkups, groupByPage, KIND_LABELS } from './diff'
import type { ChangeEntry } from './diff'
import { highlightMarkups } from './highlight'
import type { View } from '../viewer/usePanZoom'

export type CompareMode = 'side' | 'overlay'

interface Props {
  documentId: string
  /** The older and the newer revision, with their markups. */
  a: RevisionDetail
  b: RevisionDetail
  mode: CompareMode
  onMode: (m: CompareMode) => void
  symbolSets: Map<string, SymbolSet>
  initialPage: number
  /** Page-space point to centre on when the view opens. */
  focus?: { page: number; x: number; y: number } | null
  onClose: () => void
}

function usePdf(documentId: string, revisionId: string) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof loadPdf> | null = null
    setPdf(null); setError('')
    fetchRevisionPdf(documentId, revisionId).then(bytes => {
      if (cancelled) return
      task = loadPdf(bytes)
      return task.promise.then(p => { if (!cancelled) setPdf(p) })
    }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true; task?.destroy() }
  }, [documentId, revisionId])
  return { pdf, error }
}

/** Full-screen compare of two revisions: two synced plans side by side, or one red/blue multiplied overlay. */
export function CompareView({ documentId, a, b, mode, onMode, symbolSets, initialPage, focus, onClose }: Props) {
  const A = usePdf(documentId, a.id)
  const B = usePdf(documentId, b.id)
  const [pageNum, setPageNum] = useState(initialPage)
  const [opacity, setOpacity] = useState(0.85)
  const left = useRef<PaneHandle>(null)
  const right = useRef<PaneHandle>(null)
  const syncing = useRef(false)

  const diff = useMemo(() => diffMarkups(a.markups, b.markups), [a.markups, b.markups])
  const entries = useMemo(() => changeEntries(diff), [diff])
  const pageEntries = useMemo(() => entries.filter(e => e.page === pageNum), [entries, pageNum])
  const pageTotals = useMemo(() => groupByPage(entries), [entries])
  const maxPage = Math.max(A.pdf?.numPages ?? 1, B.pdf?.numPages ?? 1)

  const marksA = useMemo(() => [...a.markups, ...highlightMarkups(entries, pageNum, 'old')], [a.markups, entries, pageNum])
  const marksB = useMemo(() => [...b.markups, ...highlightMarkups(entries, pageNum, 'new')], [b.markups, entries, pageNum])
  const marksOverlay = useMemo(() => [...b.markups, ...highlightMarkups(entries, pageNum, 'both')], [b.markups, entries, pageNum])

  // Keep the two panes in step: whatever one does, the other copies.
  const follow = useCallback((from: 'left' | 'right') => (v: View) => {
    if (syncing.current) return
    syncing.current = true
    try { (from === 'left' ? right : left).current?.setView(v) } finally { syncing.current = false }
  }, [])
  const onLeftView = useMemo(() => follow('left'), [follow])
  const onRightView = useMemo(() => follow('right'), [follow])

  const focusOn = useCallback((e: { x: number; y: number; zoom?: number }) => {
    const pane = (mode === 'side' ? left : right).current
    const size = pane?.size()
    if (!pane || !size) return
    const z = e.zoom ?? Math.max(pane.view().zoom, 1)
    pane.centerOn(e.x, e.y, z)
  }, [mode])

  // Centre on the requested spot once the pages are up.
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current || !focus || !A.pdf || !B.pdf || focus.page !== pageNum) return
    const t = setTimeout(() => { focusOn({ x: focus.x, y: focus.y }); focused.current = true }, 150)
    return () => clearTimeout(t)
  }, [focus, A.pdf, B.pdf, pageNum, focusOn])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rowText = (e: ChangeEntry) => {
    const m = (e.after ?? e.before)!
    return `${m.tag || m.type}${m.text && !m.tag ? ` “${m.text.slice(0, 24)}”` : ''}`
  }
  const error = A.error || B.error

  return (
    <div className="compare-view" role="dialog" aria-label="Compare revisions" onPointerDown={e => e.stopPropagation()}>
      <header className="topbar toolbar">
        <strong className="ellipsis">{revisionName(a)} → {revisionName(b)}</strong>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Compare mode">
          <button className={mode === 'side' ? 'active' : ''} aria-pressed={mode === 'side'} onClick={() => onMode('side')}>Side by side</button>
          <button className={mode === 'overlay' ? 'active' : ''} aria-pressed={mode === 'overlay'} onClick={() => onMode('overlay')}>Overlay</button>
        </div>
        {mode === 'overlay' && (
          <label className="row small" title="How strongly the newer revision shows over the older one">
            Newer <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={e => setOpacity(Number(e.target.value))} aria-label="Overlay opacity" />
          </label>
        )}
        <button className="icon-btn" onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum <= 1} title="Previous page">‹</button>
        <span className="page-indicator">
          <span>{pageNum}</span><span className="muted"> / {maxPage}</span>
        </span>
        <button className="icon-btn" onClick={() => setPageNum(p => Math.min(maxPage, p + 1))} disabled={pageNum >= maxPage} title="Next page">›</button>
        <button className="primary" onClick={onClose}>Close</button>
      </header>
      {error && <div className="error">{error}</div>}
      <div className="compare-body">
        <div className="compare-panes">
          {mode === 'side' ? (
            <>
              <ComparePane ref={left} pdf={A.pdf} pageNum={pageNum} markups={marksA} symbolSets={symbolSets} onView={onLeftView} caption={`Older: ${revisionName(a)}`} />
              <ComparePane ref={right} pdf={B.pdf} pageNum={pageNum} markups={marksB} symbolSets={symbolSets} onView={onRightView} caption={`Newer: ${revisionName(b)}`} />
            </>
          ) : (
            <ComparePane ref={right} pdf={A.pdf} overlayPdf={B.pdf} overlayOpacity={opacity} pageNum={pageNum} markups={marksOverlay} symbolSets={symbolSets}
              caption={`Red: ${revisionName(a)} · Blue: ${revisionName(b)} · black = unchanged`} />
          )}
        </div>
        <aside className="compare-list" aria-label="Changes on this page">
          <div className="panel-heading">Page {pageNum}</div>
          {pageEntries.length === 0 && <p className="muted small">No markup changes on this page.</p>}
          <ul className="change-list">
            {pageEntries.map(e => (
              <li key={e.id}>
                <button onClick={() => focusOn({ x: e.rect.x + e.rect.width / 2, y: e.rect.y + e.rect.height / 2 })}>
                  <span className="change-name">{rowText(e)}</span>
                  <span className="muted small">{e.kinds.map(k => KIND_LABELS[k]).join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
          {pageTotals.length > 0 && (
            <p className="muted small">Also changed on page{pageTotals.filter(p => p.page !== pageNum).length === 1 ? '' : 's'}: {pageTotals.filter(p => p.page !== pageNum).map(p => p.page).join(', ') || 'none'}</p>
          )}
        </aside>
      </div>
    </div>
  )
}

