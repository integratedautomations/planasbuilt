import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, documentFileUrl, post } from '../api'
import type { Project } from '../api'
import { clampRenderScale, loadPdf } from '../pdf'
import type { PDFDocumentProxy, PDFPageProxy } from '../pdf'
import { Thumbnails } from '../viewer/Thumbnails'
import { usePanZoom } from '../viewer/usePanZoom'
import type { View } from '../viewer/usePanZoom'
import { MarkupCanvas } from '../markups/MarkupCanvas'
import type { MarkupCanvasHandle } from '../markups/MarkupCanvas'
import { SelectionBar } from '../markups/SelectionBar'
import { detectStacks } from '../markups/stacks'
import type { Stack } from '../markups/stacks'
import { ToolRail, TOOLS } from '../markups/ToolRail'
import { SidePanel, sheetHeight } from '../markups/SidePanel'
import type { PanelTab, SheetSnap } from '../markups/SidePanel'
import { CalibrateDialog } from '../markups/ScaleControl'
import type { PageScale } from '../markups/ScaleControl'
import { pathFromPoints } from '../markups/geometry'
import type { Pt } from '../markups/geometry'
import { areaBounds, areaPathIn, buildAreaIndex, deviceCounts, isArea, isSheetArea, parentChoices } from '../markups/areas'
import { useMarkups } from '../markups/useMarkups'
import { AREA_STYLE, DEFAULT_STYLE, defaultStyleFor } from '../markups/types'
import type { Layer, Markup, MarkupStyle, MarkupType, SymbolSet, Tool } from '../markups/types'
import { uuid } from '../uuid'
import { MarkupsList } from '../schedule/MarkupsList'
import type { JumpTarget } from '../schedule/MarkupsList'

interface ScaleRow { page: number; points_per_foot: number; label: string; updated_at: string }
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

/** Per-viewer toggle for area outlines and labels, remembered per project in this browser. */
function useShowAreas(projectId: string) {
  const key = `planmark.areas.show.${projectId}`
  const [show, setShow] = useState(() => { try { return localStorage.getItem(key) !== '0' } catch { return true } })
  const set = (v: boolean) => { setShow(v); try { localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ } }
  return [show, set] as const
}

/** Per-viewer toggle for device coverage cones (default on), remembered per project in this browser. */
function useShowCones(projectId: string) {
  const key = `planmark.cones.show.${projectId}`
  const [show, setShow] = useState(() => { try { return localStorage.getItem(key) !== '0' } catch { return true } })
  const set = (v: boolean) => { setShow(v); try { localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ } }
  return [show, set] as const
}

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

/** Page-space point to keep visible for a markup. */
function anchorOf(m: Markup) {
  const g = m.geometry
  if ('points' in g) {
    const n = g.points.length / 2 || 1
    let sx = 0, sy = 0
    for (let i = 0; i < g.points.length; i += 2) { sx += g.points[i]; sy += g.points[i + 1] }
    return { x: g.x + sx / n, y: g.y + sy / n }
  }
  return { x: g.x + g.width / 2, y: g.y + g.height / 2 }
}

/** Small modal asking for a name; Enter saves, Escape skips. */
function NamePrompt({ title, hint, initial, onSave, onCancel }: {
  title: string; hint: string; initial: string; onSave: (name: string) => void; onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <form onSubmit={e => { e.preventDefault(); onSave(value) }} onKeyDown={e => { if (e.key === 'Escape') onCancel() }}>
        <div className="panel-heading">{title}</div>
        <input autoFocus value={value} placeholder={hint} aria-label="Name" onChange={e => setValue(e.target.value)}
          onFocus={e => e.currentTarget.select()} />
        <div className="row">
          <button type="button" onClick={onCancel}>Skip</button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  )
}

export function ViewerPage() {
  const { projectId, documentId } = useParams() as { projectId: string; documentId: string }
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  /** Which document `pdf` was loaded for, and which pdf `page` came from (both lag a document switch). */
  const [pdfFor, setPdfFor] = useState('')
  const [pageSrc, setPageSrc] = useState<PDFDocumentProxy | null>(null)
  const [showList, setShowList] = useState(false)
  const [jumpTick, setJumpTick] = useState(0)
  const pendingJump = useRef<{ id: string; page: number } | null>(null)
  const navigate = useNavigate()
  const [pageNum, setPageNum] = useState(1)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [error, setError] = useState('')
  const [showThumbs, setShowThumbs] = useState(() => window.innerWidth >= 1025)
  const [showPanel, setShowPanel] = useState(() => window.innerWidth >= 1025)
  const isPhone = useMediaQuery('(max-width: 640px)')
  const [snap, setSnap] = useState<SheetSnap>('peek')

  const [tool, setTool] = useState<Tool>('select')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [defaultStyle, setDefaultStyle] = useState<MarkupStyle>(DEFAULT_STYLE)
  const [stampText, setStampText] = useState('APPROVED')
  const [layers, setLayers] = useState<Layer[]>([])
  const [symbolSetList, setSymbolSetList] = useState<SymbolSet[]>([])
  const [activeSetId, setActiveSetId] = useState<string | null>(null)
  const symbolSets = useMemo(() => new Map(symbolSetList.map(s => [s.id, s])), [symbolSetList])
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null)
  const [hidden, toggleHidden] = useLayerFlags(projectId, 'hidden')
  const [locked, toggleLocked] = useLayerFlags(projectId, 'locked')
  const [showAreas, setShowAreas] = useShowAreas(projectId)
  const [showCones, setShowCones] = useShowCones(projectId)
  const [boxMode, setBoxMode] = useState(false)
  const [multiSelect, setMultiSelect] = useState(false)
  const [clipCount, setClipCount] = useState(0)
  /** Name prompt: an existing area id, or (sheet) a sheet area that may not exist yet. */
  const [naming, setNaming] = useState<{ id: string | null; sheet: boolean; initial: string } | null>(null)
  const [panelTab, setPanelTab] = useState<PanelTab>('props')
  const [scales, setScales] = useState<Map<number, PageScale>>(new Map())
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleError, setScaleError] = useState('')
  const [calLine, setCalLine] = useState<[Pt, Pt] | null>(null)
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
  const { zoom, settledZoom, fit, zoomBy, centerOn, view } = usePanZoom(viewportRef, stageRef,
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
    api<SymbolSet[]>('/symbol-sets').then(sets => {
      setSymbolSetList(sets)
      setActiveSetId(id => id ?? sets[0]?.id ?? null)
    }).catch(() => {})
    api<ScaleRow[]>(`/documents/${documentId}/scales`).then(rows =>
      setScales(new Map(rows.map(r => [r.page, { pointsPerFoot: r.points_per_foot, label: r.label }])))).catch(() => {})
    let cancelled = false
    const task = loadPdf(documentFileUrl(documentId))
    task.promise.then(p => { setPdf(p); setPdfFor(documentId) }).catch(e => { if (!cancelled) setError(`Could not open PDF: ${e.message}`) })
    return () => { cancelled = true; task.destroy() }
  }, [documentId, projectId])

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    pdf.getPage(pageNum).then(p => { if (!cancelled) { setPage(p); setPageSrc(pdf) } })
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

  // A markup is hidden/locked if its custom layer or its symbol set's layer is
  const flagged = (flags: Set<string>, m: Markup) =>
    flags.has(m.layer_id ?? '') || (!!m.symbol_set_id && flags.has(`set:${m.symbol_set_id}`))
  const pageMarkups = useMemo(
    () => [...store.markups.values()].filter(m => m.page === pageNum && !flagged(hidden, m)),
    [store.markups, pageNum, hidden]) // eslint-disable-line react-hooks/exhaustive-deps
  // Area hierarchy is built from every area (even on hidden layers or with outlines hidden) so paths stay reliable.
  const areaIndex = useMemo(() => buildAreaIndex([...store.markups.values()].filter(isArea)), [store.markups])
  const pageAreas = useMemo(() => [...areaIndex.byId.values()].filter(a => a.page === pageNum), [areaIndex, pageNum])
  const areaPaths = useMemo(() => new Map(pageAreas.map(a => [a.id, areaPathIn(areaIndex, a)])), [areaIndex, pageAreas])
  const counts = useMemo(() => deviceCounts(areaIndex, store.markups.values()), [areaIndex, store.markups])
  const canvasMarkups = useMemo(() => showAreas ? pageMarkups : pageMarkups.filter(m => m.type !== 'area'), [pageMarkups, showAreas])
  const stackIndex = useMemo(() => detectStacks(pageMarkups), [pageMarkups])
  const lockedIds = useMemo(
    () => new Set(pageMarkups.filter(m => flagged(locked, m)).map(m => m.id)),
    [pageMarkups, locked]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(
    () => selectedIds.map(id => store.markups.get(id)).filter((m): m is Markup => !!m),
    [selectedIds, store.markups])

  /** Jump to a markup from the list: switch document/page if needed, then select and center it. */
  const jumpTo = useCallback((t: JumpTarget) => {
    pendingJump.current = { id: t.id, page: t.page }
    if (t.documentId !== documentId) navigate(`/projects/${projectId}/documents/${t.documentId}`)
    else { setPageNum(t.page); setJumpTick(n => n + 1) }
    if (isPhone) setShowList(false)
  }, [documentId, projectId, navigate, isPhone])

  useEffect(() => {
    const j = pendingJump.current
    if (!j || !page || !pdf || pageSrc !== pdf || pdfFor !== documentId || pageNum !== j.page || page.pageNumber !== j.page || !store.loaded) return
    const m = store.markups.get(j.id)
    if (!m || m.document_id !== documentId) return
    pendingJump.current = null
    setSelectedIds([m.id])
    const a = anchorOf(m)
    centerOn(a.x, a.y, Math.max(view.current.zoom, 1))
  }, [page, pageSrc, pdf, pdfFor, documentId, pageNum, store.loaded, store.markups, jumpTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Phones: the properties sheet follows the selection.
  const hasSelection = selectedIds.length > 0
  useEffect(() => {
    if (!isPhone) return
    setShowPanel(hasSelection)
    if (hasSelection) setSnap('peek')
  }, [hasSelection, isPhone])

  // Keep the selected markup visible above the sheet.
  const selectedKey = selectedIds.join(',')
  useEffect(() => {
    const vp = viewportRef.current
    const m = selected[0]
    if (!isPhone || !showPanel || selected.length !== 1 || snap === 'full' || !vp || !m) return
    const sheetH = sheetHeight(snap, vp.parentElement?.clientHeight ?? vp.clientHeight)
    const a = anchorOf(m)
    const v = view.current
    const sx = v.x + a.x * v.zoom, sy = v.y + a.y * v.zoom
    const margin = 40
    if (sx > margin && sx < vp.clientWidth - margin && sy > 72 && sy < vp.clientHeight - sheetH - margin) return
    centerOn(a.x, a.y + sheetH / (2 * v.zoom))
  }, [selectedKey, snap, isPhone, showPanel]) // eslint-disable-line react-hooks/exhaustive-deps

  const pageCount = pdf?.numPages ?? meta?.revisions[0]?.page_count ?? 0
  const pageScale = scales.get(pageNum) ?? null

  /** Saves a scale for this sheet, or for every sheet; keeps local state in step with the server. */
  async function saveScale(s: PageScale, allSheets: boolean) {
    if (readOnly) return
    const pages = allSheets ? Array.from({ length: pageCount || 1 }, (_, i) => i + 1) : [pageNum]
    const body = { points_per_foot: s.pointsPerFoot, label: s.label }
    setScaleBusy(true); setScaleError('')
    try {
      if (allSheets) await api(`/documents/${documentId}/scales`, { method: 'PUT', body: JSON.stringify({ ...body, pages }) })
      else await api(`/documents/${documentId}/scales/${pageNum}`, { method: 'PUT', body: JSON.stringify(body) })
      setScales(prev => { const next = new Map(prev); for (const n of pages) next.set(n, s); return next })
    } catch (e) { setScaleError((e as Error).message); throw e } finally { setScaleBusy(false) }
  }
  async function clearScale() {
    setScaleBusy(true); setScaleError('')
    try {
      await api(`/documents/${documentId}/scales/${pageNum}`, { method: 'DELETE' })
      setScales(prev => { const next = new Map(prev); next.delete(pageNum); return next })
    } catch (e) { setScaleError((e as Error).message) } finally { setScaleBusy(false) }
  }
  const openMeasure = () => { setPanelTab('measure'); setShowPanel(true); setSnap(s => (s === 'peek' ? 'half' : s)) }
  /** Select an area and zoom the plan to fit it (above the phone sheet, if open). */
  const selectArea = (id: string) => {
    const a = areaIndex.byId.get(id)
    if (!a) return
    setShowAreas(true)
    setSelectedIds([id])
    const b = areaBounds(areaIndex, id)
    const vp = viewportRef.current
    if (!b || !vp || isSheetArea(a)) { fit(); return }
    const bottom = isPhone ? sheetHeight('peek', vp.parentElement?.clientHeight ?? vp.clientHeight) : 0
    const z = Math.min(vp.clientWidth / (Math.max(b.width, 1) * 1.2), (vp.clientHeight - bottom) / (Math.max(b.height, 1) * 1.2))
    centerOn(b.x + b.width / 2, b.y + b.height / 2 + bottom / (2 * z), z)
  }
  const drawArea = (t: 'area' | 'area-rect') => { if (isPhone) setShowPanel(false); chooseTool(t) }
  const nameSheet = () => {
    const sheet = pageAreas.find(isSheetArea)
    setNaming({ id: sheet?.id ?? null, sheet: true, initial: sheet?.text ?? '' })
  }
  function saveName(name: string) {
    const n = naming
    setNaming(null)
    if (!n || readOnly) return
    const text = name.trim()
    const existing = n.id ? store.markups.get(n.id) : undefined
    if (existing) {
      if (text !== existing.text) store.commit([{ before: existing, after: { ...existing, text } }])
      return
    }
    if (!n.sheet || !text || !pageSize) return
    const sheet: Markup = {
      id: uuid(), document_id: documentId, page: pageNum, type: 'area', text,
      geometry: pathFromPoints([{ x: 0, y: 0 }, { x: pageSize.width, y: 0 }, { x: pageSize.width, y: pageSize.height }, { x: 0, y: pageSize.height }]),
      style: { ...AREA_STYLE }, layer_id: null, fields: { sheet: true },
    }
    store.commit([{ before: null, after: sheet }])
    setSelectedIds([sheet.id])
  }

  const goTo = useCallback((n: number) => setPageNum(p => Math.min(Math.max(1, n), pageCount || p)), [pageCount])

  const deleteSelected = useCallback(() => {
    if (readOnly) return
    store.commit(selected.map(m => ({ before: m, after: null })))
    setSelectedIds([])
  }, [readOnly, selected, store])

  /** Adds one more device of the stack's set at the same spot; the server numbers it. One undo step. */
  const addToStack = useCallback((stack: Stack) => {
    if (readOnly) return
    const top = stack.members[stack.members.length - 1]
    const m: Markup = {
      id: uuid(), document_id: top.document_id, page: top.page, type: 'device', geometry: { ...top.geometry },
      style: { ...top.style }, text: '', layer_id: top.layer_id, symbol_set_id: top.symbol_set_id, tag: '', status: 'planned', fields: {},
    }
    store.commit([{ before: null, after: m }])
    setSelectedIds([m.id])
  }, [readOnly, store])

  /** Moves one member 1.5 diameters to the right so it stands alone. */
  const pullOut = useCallback((m: Markup) => {
    if (readOnly || !('width' in m.geometry)) return
    const d = Math.min(m.geometry.width, m.geometry.height)
    store.commit([{ before: m, after: { ...m, geometry: { ...m.geometry, x: m.geometry.x + d * 1.5 } } }])
  }, [readOnly, store])

  const deleteStack = useCallback((stack: Stack) => {
    if (readOnly) return
    store.commit(stack.members.map(m => ({ before: m, after: null })))
    setSelectedIds([])
  }, [readOnly, store])

  const updateSelected = useCallback((patch: (m: Markup) => Markup, mergeKey: string) => {
    if (readOnly) return
    store.commit(selected.map(m => ({ before: m, after: patch(m) })), `${mergeKey}:${selectedIds.join(',')}`)
  }, [readOnly, selected, selectedIds, store])

  const setClip = useCallback((items: Markup[]) => { clipboard.current = items; setClipCount(items.length) }, [])

  const copySelected = useCallback(() => { setClip(selected.map(m => structuredClone(m))) }, [selected, setClip])

  /** Pastes the clipboard (+20pt offset, fresh device tags, sheet area skipped) onto the current page. */
  const paste = useCallback(() => {
    if (readOnly || !clipboard.current.length) return
    const copies = clipboard.current.filter(m => !isSheetArea(m)).map(m => ({
      ...m, id: uuid(), page: pageNum, tag: m.type === 'device' ? '' : m.tag, // pasted devices get fresh numbers
      geometry: { ...m.geometry, x: m.geometry.x + 20, y: m.geometry.y + 20 },
      // The copy belongs to this session, not to whoever placed the original
      created_by: undefined, created_by_name: undefined, created_at: undefined,
      updated_by: undefined, updated_by_name: undefined, updated_at: undefined, version: undefined,
    }))
    if (!copies.length) return
    setClip(copies) // paste again cascades
    store.commit(copies.map(m => ({ before: null, after: m })))
    setSelectedIds(copies.map(m => m.id))
  }, [pageNum, readOnly, store, setClip])

  const duplicateSelected = useCallback(() => { copySelected(); paste() }, [copySelected, paste])

  const chooseTool = useCallback((t: Tool) => {
    setTool(t)
    setCalLine(null)
    if (t !== 'select' && t !== 'pan') {
      setSelectedIds([])
      if (t !== 'calibrate') setDefaultStyle(s => defaultStyleFor(t as MarkupType, { ...DEFAULT_STYLE, stroke: s.stroke || DEFAULT_STYLE.stroke, strokeWidth: s.strokeWidth }))
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
      else if (mod && k === 'c') copySelected()
      else if (mod && k === 'v') { e.preventDefault(); paste() }
      else if (mod && k === 'a') { e.preventDefault(); setSelectedIds(pageMarkups.filter(m => m.type !== 'area' && !lockedIds.has(m.id)).map(m => m.id)) }
      else if (mod) return
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
      else if (e.key === 'Escape') { markupRef.current?.cancelDraft(); setSelectedIds([]); setTool('select') }
      else if (e.key === 'Enter') markupRef.current?.finishDraft()
      else if (k === 'q') setShowList(s => !s)
      else if (k === 'x') { setBoxMode(b => !b); setTool('select') }
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
  }, [pageNum, goTo, zoomBy, fit, store, selected, paste, copySelected, deleteSelected, pageMarkups, lockedIds, readOnly, chooseTool])

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
        <button className="icon-btn hide-sm" onClick={() => goTo(pageNum - 1)} disabled={pageNum <= 1} title="Previous page">‹</button>
        <span className="page-indicator">
          <input className="page-input" inputMode="numeric" value={pageNum}
            onChange={e => { const n = parseInt(e.target.value, 10); if (n) goTo(n) }} aria-label="Page number" />
          <span className="muted">/ {pageCount || '…'}</span>
        </span>
        <button className="icon-btn hide-sm" onClick={() => goTo(pageNum + 1)} disabled={pageNum >= pageCount} title="Next page">›</button>
        <span className="divider hide-sm" />
        <button className="icon-btn hide-sm" onClick={() => zoomBy(0.8)} title="Zoom out">−</button>
        <button className="zoom-label hide-sm" onClick={fit} title="Fit page (0)">{Math.round(zoom * 100)}%</button>
        <button className="icon-btn hide-sm" onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
        <button className={`scale-badge hide-sm${pageScale ? '' : ' warn'}`} title="Sheet scale (open Measure panel)" onClick={openMeasure}>
          {pageScale ? pageScale.label : 'No scale'}
        </button>
        <button className={`icon-btn${showList ? ' active' : ''}`} title="Markups list (Q)" aria-label="List" aria-pressed={showList}
          onClick={() => setShowList(s => !s)}>☷<span className="hide-sm list-btn-label">List</span></button>
        <button className={`icon-btn${showPanel ? ' active' : ''}`} title="Properties & layers" onClick={() => setShowPanel(s => !s)}>⚙</button>
      </header>
      <div className="viewer-body">
        {showThumbs && pdf && (
          <>
            <div className="scrim" onClick={() => setShowThumbs(false)} />
            <Thumbnails pdf={pdf} current={pageNum}
              onSelect={n => { goTo(n); if (window.innerWidth < 1025) setShowThumbs(false) }} />
          </>
        )}
        <ToolRail tool={activeTool} onTool={chooseTool} readOnly={readOnly} boxSelect={boxMode} onBoxSelect={() => { setBoxMode(b => !b); setTool('select') }} />
        <div className={`viewport tool-${activeTool}`} ref={viewportRef}>
          {error && <div className="error floating">{error}</div>}
          {!page && !error && <div className="center muted">Loading plan…</div>}
          {activeTool === 'calibrate' && !calLine && (
            <div className="tool-hint">Drag a line along a known dimension (Shift snaps 45°)</div>
          )}
          {(activeTool === 'area' || activeTool === 'area-rect') && (
            <div className="tool-hint">{activeTool === 'area' ? 'Click corners; click the first point, double-click or Enter to close' : 'Drag a rectangle'}</div>
          )}
          {activeTool === 'device' && (
            <div className="symbol-palette" onPointerDown={e => e.stopPropagation()}>
              {symbolSetList.length === 0 && <span className="muted small">No symbol sets yet. An admin can add them under Symbols.</span>}
              {symbolSetList.map(set => (
                <button key={set.id} className={`palette-item${set.id === activeSetId ? ' on' : ''}`}
                  title={set.name} onClick={() => setActiveSetId(set.id)}>
                  <span className="set-icon" style={{ background: set.color }}>{set.icon && <img src={set.icon} alt="" />}</span>
                  <span className="hide-sm">{set.name}</span>
                </button>
              ))}
              <button className={`palette-item cone-toggle${showCones ? ' on' : ''}`} aria-pressed={showCones}
                title={showCones ? 'Hide coverage cones' : 'Show coverage cones'} onClick={() => setShowCones(!showCones)}>
                <span className="cone-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" fillOpacity={showCones ? 0.3 : 0} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 20L4 6a12 12 0 0116 0z" /></svg>
                </span>
                <span className="hide-sm">Cones</span>
              </button>
            </div>
          )}
          {!readOnly && activeTool === 'select' && (selectedIds.length > 0 || clipCount > 0) && (
            <SelectionBar count={selected.length} canPaste={clipCount > 0} multi={multiSelect} onMulti={setMultiSelect}
              onCopy={copySelected} onPaste={paste} onDuplicate={duplicateSelected} onDelete={deleteSelected} />
          )}
          <div className="stage" ref={stageRef}
            style={pageSize ? { width: pageSize.width, height: pageSize.height } : { display: 'none' }}>
            <canvas ref={canvasRef} className="page-canvas" />
          </div>
          {page && viewportSize.width > 0 && (
            <MarkupCanvas ref={markupRef} width={viewportSize.width} height={viewportSize.height}
              zoom={settledZoom} markups={canvasMarkups} areaPaths={areaPaths} lockedIds={lockedIds} tool={activeTool} symbolSets={symbolSets}
              readOnly={readOnly} selectedIds={selectedIds} onSelect={setSelectedIds} commit={store.commit}
              consumedRef={consumedRef} boxSelect={boxMode && activeTool === 'select'} multiSelect={multiSelect && !readOnly} showCones={showCones} stacks={stackIndex} scale={pageScale?.pointsPerFoot ?? null} calLine={calLine}
              onCalibrate={(a, b) => { setCalLine([a, b]); setTool('select') }}
              newBase={{ document_id: documentId, page: pageNum, layer_id: activeLayerId, style: defaultStyle, stampText, symbolSetId: activeSetId }}
              onCreated={m => {
                if (m.type === 'area') { setTool('select'); setNaming({ id: m.id, sheet: false, initial: '' }); return }
                if (m.type === 'text') { setShowPanel(true); setTool('select'); setTimeout(() => textRef.current?.select(), 50) }
              }} />
          )}
        </div>
        {calLine && (
          <CalibrateDialog pageCount={pageCount} onCancel={() => setCalLine(null)}
            onApply={async (feet, all) => {
              const ppf = Math.hypot(calLine[1].x - calLine[0].x, calLine[1].y - calLine[0].y) / feet
              await saveScale({ pointsPerFoot: ppf, label: 'Calibrated' }, all)
              setCalLine(null)
            }} />
        )}
        {naming && <NamePrompt title={naming.sheet ? 'Name this sheet' : 'Name this area'}
          hint={naming.sheet ? 'Everything on this page will be listed under it, e.g. First Floor.' : 'e.g. Living Room'}
          initial={naming.initial} onSave={saveName} onCancel={() => setNaming(null)} />}
        {showPanel && (
          <SidePanel tab={panelTab} onTab={setPanelTab} selected={selected} readOnly={readOnly} defaultStyle={defaultStyle} onDefaultStyle={setDefaultStyle}
            stampText={stampText} onStampText={setStampText} onUpdate={updateSelected} onDelete={deleteSelected}
            layers={layers} activeLayerId={activeLayerId} onActiveLayer={setActiveLayerId}
            hidden={hidden} locked={locked} onToggleHidden={toggleHidden} onToggleLocked={toggleLocked}
            display={{ showCones, onShowCones: setShowCones }}
            stacks={stackIndex} onSelectIds={setSelectedIds} onAddToStack={addToStack} onPullOut={pullOut} onDeleteStack={deleteStack}
            onAddLayer={addLayer} textRef={textRef} symbolSets={symbolSets}
            areas={{
              pageAreas, parentOf: id => areaIndex.parents.get(id) ?? null,
              pathOf: m => areaPathIn(areaIndex, m), deviceCount: id => counts.get(id) ?? 0,
              parentChoices: a => parentChoices(areaIndex, a), show: showAreas, onShow: setShowAreas,
              onSelectArea: selectArea, onDraw: drawArea, onNameSheet: nameSheet,
            }}
            measure={{
              scale: pageScale, pageMarkups, scaleBusy, scaleError, onSelectIds: setSelectedIds,
              onPreset: s => { saveScale(s, false).catch(() => {}) },
              onApplyAll: () => { if (pageScale) saveScale(pageScale, true).catch(() => {}) },
              onClearScale: clearScale,
              onCalibrate: () => { if (isPhone) setShowPanel(false); chooseTool('calibrate') },
            }}
            sheet={isPhone ? { snap, onSnap: setSnap, onClose: () => setShowPanel(false) } : undefined} />
        )}
      </div>
      {showList && (
        <MarkupsList projectId={projectId} projectName={project?.name ?? 'Project'} documentId={documentId} documentName={meta?.name ?? ''}
          pageNum={pageNum} markups={store.markups} commit={store.commit} symbolSets={symbolSets} localScales={scales}
          selectedIds={selectedIds} readOnly={readOnly} canImport={!readOnly && !!project} isPhone={isPhone}
          onJump={jumpTo} onClose={() => setShowList(false)} />
      )}
    </div>
  )
}
