import { useEffect, useRef, useState } from 'react'
import { ContextMenu } from '../markups/ContextMenu'
import type { MenuItem } from '../markups/ContextMenu'
import { PDFDocumentProxy } from '../pdf'
import { clearTextSelection, clickSelect, guardRangeMouseDown, keySelect } from '../ui/listSelection'

const THUMB_WIDTH = 200

/** What the Pages panel asks the viewer to do. `pages` are 1-based and sorted. */
export type PageAction =
  | { type: 'rotate' | 'delete' | 'extract' | 'replace' | 'print'; pages: number[] }
  | { type: 'insert'; at: number }
  | { type: 'move'; from: number; to: number }

interface Props {
  pdf: PDFDocumentProxy
  current: number
  onSelect: (page: number) => void
  /** Editors get the page tools; viewers only get Extract. */
  canEdit?: boolean
  onAction?: (a: PageAction) => void
}

export function Thumbnails({ pdf, current, onSelect, canEdit, onAction }: Props) {
  const pages = Array.from({ length: pdf.numPages }, (_, i) => i + 1)
  const [picked, setPicked] = useState<number[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; page: number } | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  useEffect(() => { setPicked([]) }, [pdf])

  /** Pages an action applies to: the multi-selection when the target is in it, else the target alone. */
  const targets = (page: number) => (picked.includes(page) ? [...picked].sort((a, b) => a - b) : [page])
  const act = (a: PageAction) => onAction?.(a)
  const anchor = useRef<number | null>(null)
  const click = (e: React.MouseEvent, n: number) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const r = clickSelect(pages, { selected: picked, anchor: anchor.current ?? current }, n, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })
      anchor.current = r.anchor
      setPicked(r.selected)
      clearTextSelection()
      return
    }
    anchor.current = n
    setPicked([])
    onSelect(n)
  }

  const items = (page: number): MenuItem[] => {
    const t = targets(page)
    const which = t.length === 1 ? `page ${t[0]}` : `${t.length} pages`
    const extract: MenuItem = { label: `Extract ${which}…`, onClick: () => act({ type: 'extract', pages: t }) }
    const print: MenuItem = { label: `Print ${which}…`, onClick: () => act({ type: 'print', pages: t }) }
    if (!canEdit) return [print, extract]
    return [
      { label: `Rotate ${which} 90° clockwise`, onClick: () => act({ type: 'rotate', pages: t }) },
      { label: `Delete ${which}`, onClick: () => act({ type: 'delete', pages: t }) },
      { label: '', separator: true },
      { label: 'Insert pages before…', onClick: () => act({ type: 'insert', at: t[0] }) },
      { label: 'Insert pages after…', onClick: () => act({ type: 'insert', at: t[t.length - 1] + 1 }) },
      { label: `Replace ${which}…`, onClick: () => act({ type: 'replace', pages: t }) },
      { label: '', separator: true },
      print,
      extract,
      { label: 'Move to start', disabled: page === 1, onClick: () => act({ type: 'move', from: page, to: 1 }) },
      { label: 'Move to end', disabled: page === pages.length, onClick: () => act({ type: 'move', from: page, to: pages.length }) },
    ]
  }

  const bar = picked.length ? picked : [current]
  const barLabel = bar.length === 1 ? `page ${bar[0]}` : `${bar.length} pages`
  return (
    <aside className="thumbs" aria-label="Pages" tabIndex={-1} onKeyDown={e => {
      const r = keySelect(pages, { selected: picked, anchor: anchor.current }, e)
      if (r) { e.preventDefault(); e.stopPropagation(); anchor.current = r.anchor; setPicked(r.selected) }
    }}>
      <div className="page-tools" role="toolbar" aria-label="Page tools">
        {canEdit && <button className="icon-btn small" title={`Rotate ${barLabel} 90° clockwise`} aria-label="Rotate pages" onClick={() => act({ type: 'rotate', pages: bar })}>⟳</button>}
        {canEdit && <button className="icon-btn small" title={`Delete ${barLabel}`} aria-label="Delete pages" onClick={() => act({ type: 'delete', pages: bar })}>🗑</button>}
        {canEdit && <button className="icon-btn small" title={`Insert pages after ${bar[bar.length - 1]}`} aria-label="Insert pages" onClick={() => act({ type: 'insert', at: bar[bar.length - 1] + 1 })}>＋</button>}
        {canEdit && <button className="icon-btn small" title={`Replace ${barLabel}`} aria-label="Replace pages" onClick={() => act({ type: 'replace', pages: bar })}>⇄</button>}
        <button className="icon-btn small" title={`Print ${barLabel}`} aria-label="Print pages" onClick={() => act({ type: 'print', pages: bar })}>🖨</button>
        <button className="icon-btn small" title={`Extract ${barLabel} to a new PDF`} aria-label="Extract pages" onClick={() => act({ type: 'extract', pages: bar })}>⤓</button>
      </div>
      {pages.map(n => (
        <button key={n}
          className={`thumb${n === current ? ' active' : ''}${picked.includes(n) ? ' picked' : ''}${over === n && dragging !== n ? ' drop-target' : ''}`}
          onMouseDown={guardRangeMouseDown}
          onClick={e => click(e, n)}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, page: n }) }}
          draggable={!!canEdit}
          onDragStart={e => { setDragging(n); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(n)) }}
          onDragOver={e => { if (dragging !== null) { e.preventDefault(); setOver(n) } }}
          onDragLeave={() => setOver(o => (o === n ? null : o))}
          onDrop={e => { e.preventDefault(); const from = dragging; setDragging(null); setOver(null); if (from !== null && from !== n) act({ type: 'move', from, to: n }) }}
          onDragEnd={() => { setDragging(null); setOver(null) }}>
          <Thumb pdf={pdf} pageNum={n} />
          <span>{n}</span>
        </button>
      ))}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.page)} onClose={() => setMenu(null)} />}
    </aside>
  )
}

// Renders only while the thumbnail is (nearly) in view and frees the bitmap when it scrolls away,
// so a long plan set never holds every page's canvas at once (iOS kills the tab when it runs out).
function Thumb({ pdf, pageNum }: { pdf: PDFDocumentProxy; pageNum: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let task: { cancel: () => void } | null = null
    let active = false
    let run = 0
    const release = () => {
      active = false
      run++
      task?.cancel(); task = null
      canvas.width = canvas.height = 0 // frees the bitmap; the aspect-ratio style keeps the row height
    }
    const draw = async () => {
      active = true
      const mine = ++run
      const page = await pdf.getPage(pageNum)
      if (mine !== run) { page.cleanup(); return }
      const base = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: (THUMB_WIDTH * Math.min(window.devicePixelRatio || 1, 2)) / base.width })
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`
      const t = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp })
      task = t
      try { await t.promise } catch { /* cancelled */ }
      if (task === t) task = null
      page.cleanup() // drop the operator list and decoded images (pdf.js defers it if another render is running)
    }
    const io = new IntersectionObserver(entries => {
      const visible = entries[entries.length - 1].isIntersecting
      if (visible && !active) void draw().catch(() => { active = false })
      else if (!visible && active) release()
    }, { root: canvas.closest('.thumbs'), rootMargin: '300px 0px' })
    io.observe(canvas)
    return () => { io.disconnect(); release() }
  }, [pdf, pageNum])
  return <canvas ref={ref} className="thumb-canvas" />
}
