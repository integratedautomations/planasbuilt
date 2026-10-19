import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { post } from '../api'
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
import { ToolRail } from '../markups/ToolRail'
import { ToolChest } from '../markups/ToolChest'
import { buildToolEntries, activeEntryId } from '../markups/toolEntries'
import type { ToolEntry } from '../markups/toolEntries'
import { ContextMenu } from '../markups/ContextMenu'
import type { MenuItem } from '../markups/ContextMenu'
import { MarkupPopup } from '../markups/MarkupInfo'
import { copyMarkup } from '../markups/copy'
import { markupBounds } from '../markups/selection'
import { DockZone } from '../viewer/DockZone'
import { usePrefs, setPref, getPrefs } from '../prefs/store'
import { pushRecent, toggleFavorite } from '../prefs/prefs'
import { commandForEvent, isTypingTarget, keyName, parseCombo, resolveHotkeys } from '../prefs/hotkeys'
import { HotkeyDialog } from '../prefs/HotkeyDialog'
import { movePanel, panelsIn, PANEL_TITLES, setPanelOpen, setZoneSize } from '../prefs/layout'
import type { Dock, PanelId } from '../prefs/layout'
import { SidePanel, sheetHeight } from '../markups/SidePanel'
import type { PanelTab, SheetSnap } from '../markups/SidePanel'
import { CalibrateDialog } from '../markups/ScaleControl'
import type { PageScale } from '../markups/ScaleControl'
import { pathFromPoints } from '../markups/geometry'
import type { Pt } from '../markups/geometry'
import { areaBounds, areaPathIn, buildAreaIndex, deviceCounts, isArea, isSheetArea, parentChoices } from '../markups/areas'
import { useMarkups } from '../markups/useMarkups'
import { invalidatePdf, loadDocMeta, loadLayers, loadPdfBytes, loadProject, loadScales, loadSymbolSets } from '../offline/cache'
import { OfflineMissError } from '../offline/classify'
import { OfflineBanner } from '../offline/OfflineBanner'
import { SyncIndicator } from '../offline/SyncIndicator'
import { queueScaleDelete, queueScalePut } from '../offline/sync'
import { AREA_STYLE, DEFAULT_STYLE, defaultStyleFor } from '../markups/types'
import type { Layer, Markup, MarkupStyle, MarkupType, SymbolSet, Tool } from '../markups/types'
import { uuid } from '../uuid'
import { Avatars } from '../realtime/Avatars'
import { deletedToast } from '../realtime/handlers'
import { usePeers } from '../realtime/hooks'
import { joinDocument, on as onSocket, sendPresence } from '../realtime/socket'
import { PdfMenu } from '../pdfio/PdfMenu'
import { MarkupsList } from '../schedule/MarkupsList'
import type { JumpTarget } from '../schedule/MarkupsList'

type DocMeta = Awaited<ReturnType<typeof loadDocMeta>>['data']

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
  /** Bumped when a new revision of this plan was uploaded: reloads the PDF. */
  const [reloadTick, setReloadTick] = useState(0)
  const loadedRevision = useRef<string | undefined>(undefined)
  const [notCached, setNotCached] = useState(false)
  const [showThumbs, setShowThumbs] = useState(() => window.innerWidth >= 1025)
  const [showPanel, setShowPanel] = useState(() => window.innerWidth >= 1025)
  const isPhone = useMediaQuery('(max-width: 640px)')
  const [snap, setSnap] = useState<SheetSnap>('peek')

  const [tool, setTool] = useState<Tool>('select')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const prefs = usePrefs()
  const hotkeys = useMemo(() => resolveHotkeys(prefs.hotkeys), [prefs.hotkeys])
  const layout = prefs.layout
  /** Square / Circle tools are the rectangle / ellipse tools with the shape locked. */
  const [shapeLock, setShapeLock] = useState<'square' | 'circle' | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; hitId: string | null; point: Pt } | null>(null)
  const [showHotkeys, setShowHotkeys] = useState(false)
  const [zoneTab, setZoneTab] = useState<Partial<Record<Dock, PanelId>>>({})
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

  // ---- live sync: presence out, remote changes in
  const canHover = useMediaQuery('(hover: hover)')
  const peers = usePeers()
  const peersHere = useMemo(() => peers.filter(p => p.page === pageNum), [peers, pageNum])
  const [toast, setToast] = useState('')
  const cursorRef = useRef<Pt | null>(null)
  const presenceRef = useRef({ page: 1, selection: [] as string[] })
  const peersRef = useRef(peers)
  peersRef.current = peers
  const knownMarkups = useRef(new Map<string, { tag?: string; type: string }>())
  for (const m of store.markups.values()) knownMarkups.current.set(m.id, { tag: m.tag, type: m.type })
  const pendingCenter = useRef<{ page: number; x: number; y: number } | null>(null)

  useEffect(() => { joinDocument(documentId); return () => joinDocument(null) }, [documentId])
  useEffect(() => {
    if (presenceRef.current.page !== pageNum) cursorRef.current = null // old page's coordinates
    presenceRef.current = { page: pageNum, selection: selectedIds }
    sendPresence({ page: pageNum, cursor: cursorRef.current, selection: selectedIds })
  }, [pageNum, selectedIds])
  const onCursor = useCallback((p: Pt | null) => {
    cursorRef.current = p
    sendPresence({ ...presenceRef.current, cursor: p })
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(t)
  }, [toast])
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
    loadDocMeta(documentId).then(r => setMeta(r.data)).catch(e => setError(e.message))
    loadProject(projectId).then(r => setProject(r.data)).catch(() => {})
    loadLayers(projectId).then(r => setLayers(r.data)).catch(() => {})
    loadSymbolSets().then(({ data: sets }) => {
      setSymbolSetList(sets)
      setActiveSetId(id => id ?? sets[0]?.id ?? null)
    }).catch(() => {})
    loadScales(documentId).then(({ data: rows }) =>
      setScales(new Map(rows.map(r => [r.page, { pointsPerFoot: r.points_per_foot, label: r.label }])))).catch(() => {})
    let cancelled = false
    let task: ReturnType<typeof loadPdf> | null = null
    setNotCached(false)
    loadDocMeta(documentId).then(r => r.data.revisions[0]?.id, () => undefined).then(revisionId => {
      loadedRevision.current = revisionId
      return loadPdfBytes(documentId, revisionId)
    }).then(bytes => {
      if (cancelled) return
      task = loadPdf(bytes)
      return task.promise.then(p => {
        if (cancelled) return
        setPdf(p); setPdfFor(documentId)
        setPageNum(n => Math.min(n, p.numPages))
      })
    }).catch(e => {
      if (cancelled) return
      if (e instanceof OfflineMissError) setNotCached(true)
      else setError(`Could not open PDF: ${e.message}`)
    })
    return () => { cancelled = true; task?.destroy() }
  }, [documentId, projectId, reloadTick])

  // Things other people changed (or that we missed while disconnected): refetch the lists we show.
  useEffect(() => {
    const offs = [
      onSocket('scales', () => { loadScales(documentId).then(({ data: rows }) =>
        setScales(new Map(rows.map(r => [r.page, { pointsPerFoot: r.points_per_foot, label: r.label }])))).catch(() => {}) }),
      // A new revision was uploaded (or we missed one while offline): drop the stored PDF and reload.
      onSocket('revision', () => {
        loadDocMeta(documentId).then(r => {
          const latest = r.data.revisions[0]
          if (r.fromCache || !latest || latest.id === loadedRevision.current) return
          setToast(`Revision ${latest.revision} was uploaded; reloading the plan.`)
          void invalidatePdf(documentId).then(() => setReloadTick(t => t + 1))
        }).catch(() => {})
      }),
      onSocket('layers', () => { loadLayers(projectId).then(r => setLayers(r.data)).catch(() => {}) }),
      onSocket('symbol_sets', () => { loadSymbolSets().then(r => setSymbolSetList(r.data)).catch(() => {}) }),
      onSocket('markup', msg => {
        if (!msg.applied || msg.op !== 'delete') return
        // The selected markup was deleted by someone else: deselect it and say so.
        setSelectedIds(ids => {
          if (!ids.includes(msg.id)) return ids
          const k = knownMarkups.current.get(msg.id)
          const who = peersRef.current.find(p => p.userId === msg.by || p.name === msg.by)?.name ?? msg.by
          setToast(deletedToast(who, k?.tag, k?.type))
          return ids.filter(i => i !== msg.id)
        })
      }),
    ]
    return () => offs.forEach(off => off())
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
  /** Markups kept from an earlier revision whose pages the current PDF no longer has. */
  const orphaned = useMemo(() => {
    const pages = new Set<number>()
    let count = 0
    if (pdf) for (const m of store.markups.values()) if (m.page > pdf.numPages) { pages.add(m.page); count++ }
    return { count, pages: [...pages].sort((a, b) => a - b) }
  }, [pdf, store.markups])
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

  /** Avatar tap: go to that person's page and centre on their cursor or selection. */
  const jumpToPeer = useCallback((p: { page: number | null; cursor: Pt | null; selection: string[] }) => {
    const sel = p.selection.map(id => store.markups.get(id)).find(m => !!m)
    const at = p.cursor ?? (sel ? anchorOf(sel) : null)
    const target = p.page ?? pageNum
    if (at) pendingCenter.current = { page: target, x: at.x, y: at.y }
    if (target !== pageNum) setPageNum(Math.min(Math.max(1, target), pageCount || target))
    setJumpTick(n => n + 1)
  }, [store.markups, pageNum]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = pendingCenter.current
    if (!c || !page || pageSrc !== pdf || page.pageNumber !== c.page) return
    pendingCenter.current = null
    centerOn(c.x, c.y, Math.max(view.current.zoom, 0.5))
  }, [page, pageSrc, pdf, jumpTick]) // eslint-disable-line react-hooks/exhaustive-deps

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
      await queueScalePut(documentId, pages, body)
      setScales(prev => { const next = new Map(prev); for (const n of pages) next.set(n, s); return next })
    } catch (e) { setScaleError((e as Error).message); throw e } finally { setScaleBusy(false) }
  }
  async function clearScale() {
    setScaleBusy(true); setScaleError('')
    try {
      await queueScaleDelete(documentId, pageNum)
      setScales(prev => { const next = new Map(prev); next.delete(pageNum); return next })
    } catch (e) { setScaleError((e as Error).message) } finally { setScaleBusy(false) }
  }
  const openMeasure = () => { setPanelTab('measure'); openPanel('props'); setSnap(s => (s === 'peek' ? 'half' : s)) }
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

  /**
   * Pastes the clipboard onto the current page (sheet area skipped). Default: +20pt offset; inPlace: same spot;
   * at: top-left of the group lands on that point. Copies get no tag and lose IP/MAC/serial (see markups/copy.ts).
   */
  const paste = useCallback((opts: { inPlace?: boolean; at?: Pt } = {}) => {
    if (readOnly || !clipboard.current.length) return
    const src = clipboard.current.filter(m => !isSheetArea(m))
    if (!src.length) return
    let dx = 20, dy = 20
    if (opts.inPlace) { dx = 0; dy = 0 } else if (opts.at) {
      const bs = src.map(markupBounds)
      dx = opts.at.x - Math.min(...bs.map(b => b.x))
      dy = opts.at.y - Math.min(...bs.map(b => b.y))
    }
    const copies = src.map(m => copyMarkup(m, { page: pageNum, dx, dy, set: m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined }))
    if (!opts.inPlace) setClip(copies) // paste again cascades
    store.commit(copies.map(m => ({ before: null, after: m })))
    setSelectedIds(copies.map(m => m.id))
  }, [pageNum, readOnly, store, setClip, symbolSets])

  const duplicateSelected = useCallback(() => { copySelected(); paste() }, [copySelected, paste])

  const cutSelected = useCallback(() => { if (readOnly) return; copySelected(); deleteSelected() }, [readOnly, copySelected, deleteSelected])

  const toolEntries = useMemo(() => buildToolEntries(symbolSetList), [symbolSetList])
  const entryMap = useMemo(() => new Map(toolEntries.map(e => [e.id, e])), [toolEntries])

  const chooseTool = useCallback((t: Tool, shape: 'square' | 'circle' | null = null) => {
    setTool(t)
    setShapeLock(shape)
    setCalLine(null)
    if (t !== 'select' && t !== 'pan') {
      setSelectedIds([])
      if (t !== 'calibrate') setDefaultStyle(s => defaultStyleFor(t as MarkupType, { ...DEFAULT_STYLE, stroke: s.stroke || DEFAULT_STYLE.stroke, strokeWidth: s.strokeWidth }))
    }
  }, [])

  /** Picks a Tool chest entry (from the chest, a favorite, the context menu or a hotkey) and remembers it as recent. */
  const pickEntry = useCallback((e: ToolEntry) => {
    if (e.setId) setActiveSetId(e.setId)
    chooseTool(e.tool, e.shape ?? null)
    if (e.tool !== 'select' && e.tool !== 'pan') setPref('recent', pushRecent(getPrefs().recent, e.id))
  }, [chooseTool])

  const setPanel = useCallback((id: PanelId, open: boolean) => {
    if (isPhone) {
      if (id === 'pages') setShowThumbs(open); else if (id === 'props') setShowPanel(open); else if (id === 'markups') setShowList(open)
      return
    }
    const l = getPrefs().layout
    setPref('layout', setPanelOpen(l, id, open))
    if (open) setZoneTab(z => ({ ...z, [l.panels[id].dock]: id }))
  }, [isPhone])
  const panelOpen = (id: PanelId) =>
    isPhone ? (id === 'pages' ? showThumbs : id === 'props' ? showPanel : id === 'markups' ? showList : false) : layout.panels[id].open
  const openPanel = (id: PanelId) => setPanel(id, true)
  const togglePanel = (id: PanelId) => setPanel(id, !panelOpen(id))
  const closeCtx = useCallback(() => setCtx(null), [])

  /** Runs a hotkey command. Returns false when the id is not handled. */
  const runCommand = (cmd: string): boolean => {
    if (cmd.startsWith('tool.')) {
      const entry = toolEntries.find(e => e.command === cmd)
      const allowed = (t: Tool) => !readOnly || t === 'select' || t === 'pan'
      if (entry) { if (allowed(entry.tool)) pickEntry(entry); return true }
      if (cmd === 'tool.device') { if (allowed('device')) chooseTool('device'); return true }
      return false
    }
    switch (cmd) {
      case 'edit.undo': store.undo(); setSelectedIds([]); return true
      case 'edit.redo': case 'edit.redoAlt': store.redo(); setSelectedIds([]); return true
      case 'edit.cut': cutSelected(); return true
      case 'edit.copy': copySelected(); return true
      case 'edit.paste': paste(); return true
      case 'edit.pasteInPlace': paste({ inPlace: true }); return true
      case 'edit.duplicate': if (!readOnly && selected.length) duplicateSelected(); return true
      case 'edit.delete': case 'edit.deleteAlt': deleteSelected(); return true
      case 'edit.selectAll': setSelectedIds(pageMarkups.filter(m => m.type !== 'area' && !lockedIds.has(m.id)).map(m => m.id)); return true
      case 'edit.escape': markupRef.current?.cancelDraft(); setSelectedIds([]); setTool('select'); setShapeLock(null); return true
      case 'edit.finish': markupRef.current?.finishDraft(); return true
      case 'select.boxMode': setBoxMode(b => !b); setTool('select'); return true
      case 'view.zoomIn': zoomBy(1.25); return true
      case 'view.zoomOut': zoomBy(0.8); return true
      case 'view.fit': fit(); return true
      case 'view.nextPage': goTo(pageNum + 1); return true
      case 'view.prevPage': goTo(pageNum - 1); return true
      case 'panel.markups': togglePanel('markups'); return true
      case 'panel.tools': togglePanel('tools'); return true
      case 'panel.props': togglePanel('props'); return true
      case 'panel.pages': togglePanel('pages'); return true
      default: return false
    }
  }

  // One key listener for every command in the hotkey registry; ignored while typing or while a menu/dialog is open
  const runRef = useRef(runCommand)
  runRef.current = runCommand
  const modalOpen = showHotkeys || !!ctx
  useEffect(() => {
    if (modalOpen) return
    const panKey = parseCombo(hotkeys['view.panHold'])?.key
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const cmd = commandForEvent(e, hotkeys)
      if (!cmd) return
      if (cmd === 'view.panHold') { e.preventDefault(); if (!e.repeat) setSpaceHeld(true); return }
      if (runRef.current(cmd)) e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => { if (panKey && keyName(e) === panKey) setSpaceHeld(false) }
    const onBlur = () => setSpaceHeld(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur) }
  }, [hotkeys, modalOpen])

  async function addLayer(name: string) {
    const layer = await post<Layer>(`/projects/${projectId}/layers`, { name })
    setLayers(ls => [...ls, layer])
    setActiveLayerId(layer.id)
  }

  const viewportEl = (
    <div className={'viewport tool-' + activeTool} ref={viewportRef} onContextMenu={e => e.preventDefault()}>
      {error && <div className="error floating">{error}</div>}
      {!page && !error && !notCached && <div className="center muted">Loading plan…</div>}
      {notCached && <div className="center muted">Plan not available offline.</div>}
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
            <button key={set.id} className={'palette-item' + (set.id === activeSetId ? ' on' : '')}
              title={set.name} onClick={() => setActiveSetId(set.id)}>
              <span className="set-icon" style={{ background: set.color }}>{set.icon && <img src={set.icon} alt="" />}</span>
              <span className="hide-sm">{set.name}</span>
            </button>
          ))}
          <button className={'palette-item cone-toggle' + (showCones ? ' on' : '')} aria-pressed={showCones}
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
          onCopy={copySelected} onPaste={() => paste()} onDuplicate={duplicateSelected} onDelete={deleteSelected} />
      )}
      {!isPhone && activeTool === 'select' && selected.length === 1 && (
        <MarkupPopup key={selected[0].id} markup={selected[0]} sets={symbolSetList}
          set={selected[0].symbol_set_id ? symbolSets.get(selected[0].symbol_set_id) : undefined}
          areaPath={selected[0].type === 'area' ? undefined : areaPathIn(areaIndex, selected[0])}
          fields={prefs.popupFields} onFields={ids => setPref('popupFields', ids)} />
      )}
      <div className="stage" ref={stageRef}
        style={pageSize ? { width: pageSize.width, height: pageSize.height } : { display: 'none' }}>
        <canvas ref={canvasRef} className="page-canvas" />
      </div>
      {page && viewportSize.width > 0 && (
        <MarkupCanvas ref={markupRef} width={viewportSize.width} height={viewportSize.height}
          zoom={settledZoom} markups={canvasMarkups} areaPaths={areaPaths} lockedIds={lockedIds} tool={activeTool} symbolSets={symbolSets}
          readOnly={readOnly} selectedIds={selectedIds} onSelect={setSelectedIds} commit={store.commit}
          peers={peersHere} onCursor={canHover ? onCursor : undefined}
          onContextMenu={info => setCtx({ x: info.clientX, y: info.clientY, hitId: info.hitId, point: info.point })}
          constrain={!!shapeLock}
          consumedRef={consumedRef} boxSelect={boxMode && activeTool === 'select'} multiSelect={multiSelect && !readOnly} showCones={showCones} stacks={stackIndex} scale={pageScale?.pointsPerFoot ?? null} calLine={calLine}
          onCalibrate={(a, b) => { setCalLine([a, b]); setTool('select') }}
          newBase={{ document_id: documentId, page: pageNum, layer_id: activeLayerId, style: defaultStyle, stampText, symbolSetId: activeSetId }}
          onCreated={m => {
            if (m.type === 'area') { setTool('select'); setNaming({ id: m.id, sheet: false, initial: '' }); return }
            if (m.type === 'text') { openPanel('props'); setTool('select'); setTimeout(() => textRef.current?.select(), 50) }
          }} />
      )}
    </div>
  )

  const dialogs = (
    <>
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
    </>
  )

  const sidePanelEl = (
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
  )

  const markupsListEl = (docked: boolean) => (
    <MarkupsList projectId={projectId} projectName={project?.name ?? 'Project'} documentId={documentId} documentName={meta?.name ?? ''}
      pageNum={pageNum} markups={store.markups} commit={store.commit} symbolSets={symbolSets} localScales={scales}
      selectedIds={selectedIds} readOnly={readOnly} canImport={!readOnly && !!project} isPhone={isPhone} docked={docked}
      visibleColumns={prefs.listColumns} onVisibleColumns={ids => setPref('listColumns', ids)}
      onJump={jumpTo} onClose={() => (docked ? setPanel('markups', false) : setShowList(false))} />
  )

  const panelNodes: Record<PanelId, ReactNode> = {
    tools: <ToolChest entries={toolEntries} activeId={activeEntryId(tool, shapeLock, activeSetId)} favorites={prefs.favorites} recent={prefs.recent}
      hotkeys={hotkeys} readOnly={readOnly} onPick={pickEntry} onFavorites={ids => setPref('favorites', ids)}
      onToggleFavorite={id => setPref('favorites', toggleFavorite(getPrefs().favorites, id))} />,
    pages: pdf ? <Thumbnails pdf={pdf} current={pageNum} onSelect={goTo} /> : <div className="muted small dock-empty">Loading…</div>,
    props: sidePanelEl,
    markups: markupsListEl(true),
  }

  const zone = (d: Dock) => {
    const ids = panelsIn(layout, d)
    if (!ids.length) return null
    const wanted = zoneTab[d]
    return (
      <DockZone side={d} panels={ids.map(id => ({ id, title: PANEL_TITLES[id], node: panelNodes[id] }))}
        active={wanted && ids.includes(wanted) ? wanted : ids[0]} onActive={id => setZoneTab(z => ({ ...z, [d]: id }))}
        size={layout.sizes[d]} onSize={n => setPref('layout', setZoneSize(getPrefs().layout, d, n))}
        onMove={(id, to) => { setPref('layout', movePanel(getPrefs().layout, id, to)); setZoneTab(z => ({ ...z, [to]: id })) }}
        onHide={id => setPanel(id, false)} />
    )
  }

  const ctxItems = (c: { hitId: string | null; point: Pt }): MenuItem[] => {
    const hint = (id: string) => hotkeys[id] || undefined
    const sub = (ids: string[]): MenuItem[] => ids.map(id => entryMap.get(id))
      .filter((e): e is ToolEntry => !!e && (!readOnly || e.tool === 'select' || e.tool === 'pan'))
      .map(e => ({ label: e.label, hint: e.command ? hint(e.command) : undefined, onClick: () => pickEntry(e) }))
    const tools: MenuItem[] = [{ label: 'Favorites', sub: sub(prefs.favorites) }, { label: 'Recent tools', sub: sub(prefs.recent) }]
    const canPaste = clipCount > 0 && !readOnly
    if (c.hitId) {
      return [
        { label: 'Cut', hint: hint('edit.cut'), disabled: readOnly, onClick: cutSelected },
        { label: 'Copy', hint: hint('edit.copy'), onClick: copySelected },
        { label: 'Paste', hint: hint('edit.paste'), disabled: !canPaste, onClick: () => paste() },
        { label: 'Paste in place', hint: hint('edit.pasteInPlace'), disabled: !canPaste, onClick: () => paste({ inPlace: true }) },
        { label: 'Delete', hint: hint('edit.delete'), disabled: readOnly, onClick: deleteSelected },
        { label: 'Duplicate', hint: hint('edit.duplicate'), disabled: readOnly, onClick: duplicateSelected },
        { label: '', separator: true },
        ...tools,
      ]
    }
    return [
      ...tools,
      { label: '', separator: true },
      { label: 'Paste', hint: hint('edit.paste'), disabled: !canPaste, onClick: () => paste({ at: c.point }) },
      { label: 'Paste in place', hint: hint('edit.pasteInPlace'), disabled: !canPaste, onClick: () => paste({ inPlace: true }) },
    ]
  }

  return (
    <div className="viewer">
      <header className="topbar toolbar">
        <Link to={'/projects/' + projectId} className="icon-btn" title="Back to plans">←</Link>
        <button className={'icon-btn' + (!isPhone && panelOpen('pages') ? ' active' : '')} title="Pages" aria-pressed={panelOpen('pages')} onClick={() => togglePanel('pages')}>☰</button>
        {!isPhone && <button className={'icon-btn' + (panelOpen('tools') ? ' active' : '')} title={'Tool chest (' + (hotkeys['panel.tools'] || 'no key') + ')'} aria-label="Tool chest" aria-pressed={panelOpen('tools')} onClick={() => togglePanel('tools')}>🧰</button>}
        <span className="crumb ellipsis">{meta?.name ?? '…'}</span>
        <SyncIndicator />
        <span className="spacer" />
        <Avatars peers={peers} max={isPhone ? 2 : 4} onJump={jumpToPeer} />
        {!readOnly && (
          <>
            <button className="icon-btn" onClick={() => { store.undo(); setSelectedIds([]) }} disabled={!store.canUndo} title={'Undo (' + hotkeys['edit.undo'] + ')'}>↶</button>
            <button className="icon-btn" onClick={() => { store.redo(); setSelectedIds([]) }} disabled={!store.canRedo} title={'Redo (' + hotkeys['edit.redo'] + ')'}>↷</button>
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
        <button className="zoom-label hide-sm" onClick={fit} title={'Fit page (' + hotkeys['view.fit'] + ')'}>{Math.round(zoom * 100)}%</button>
        <button className="icon-btn hide-sm" onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
        <button className={'scale-badge hide-sm' + (pageScale ? '' : ' warn')} title="Sheet scale (open Measure panel)" onClick={openMeasure}>
          {pageScale ? pageScale.label : 'No scale'}
        </button>
        <PdfMenu documentId={documentId} documentName={meta?.name ?? 'plan'} markups={store.markups} symbolSets={symbolSets}
          scales={scales} readOnly={readOnly} commit={store.commit} />
        <button className="icon-btn hide-sm" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => setShowHotkeys(true)}>⌨</button>
        <button className={'icon-btn' + (panelOpen('markups') ? ' active' : '')} title={'Markups list (' + (hotkeys['panel.markups'] || 'no key') + ')'} aria-label="List" aria-pressed={panelOpen('markups')}
          onClick={() => togglePanel('markups')}>☷<span className="hide-sm list-btn-label">List</span></button>
        <button className={'icon-btn' + (panelOpen('props') ? ' active' : '')} title="Properties & layers" aria-pressed={panelOpen('props')} onClick={() => togglePanel('props')}>⚙</button>
      </header>
      <OfflineBanner always={notCached}>{notCached
        ? "You're offline and this plan isn't saved on this device. Open it once online, or use \"Make available offline\" on the project page."
        : undefined}</OfflineBanner>
      {orphaned.count > 0 && (
        <div className="rev-banner" role="status">
          {orphaned.count} markup{orphaned.count === 1 ? ' is' : 's are'} on page{orphaned.pages.length === 1 ? '' : 's'} {orphaned.pages.join(', ')},
          which Rev {meta?.revisions[0]?.revision ?? ''} of this plan no longer has. They are kept in the Markups list.
        </div>
      )}
      {isPhone ? (
        <>
          <div className="viewer-body">
            {showThumbs && pdf && (
              <>
                <div className="scrim" onClick={() => setShowThumbs(false)} />
                <Thumbnails pdf={pdf} current={pageNum}
                  onSelect={n => { goTo(n); if (window.innerWidth < 1025) setShowThumbs(false) }} />
              </>
            )}
            <ToolRail hotkeys={hotkeys} tool={activeTool} onTool={chooseTool} readOnly={readOnly} boxSelect={boxMode} onBoxSelect={() => { setBoxMode(b => !b); setTool('select') }} />
            {viewportEl}
            {dialogs}
            {showPanel && sidePanelEl}
          </div>
          {toast && <div className="live-toast" role="status">{toast}</div>}
          {showList && markupsListEl(false)}
        </>
      ) : (
        <>
          <div className="viewer-body docked">
            {zone('left')}
            <div className="dock-center">
              <div className="dock-main">{viewportEl}</div>
              {zone('bottom')}
            </div>
            {zone('right')}
            {dialogs}
          </div>
          {toast && <div className="live-toast" role="status">{toast}</div>}
        </>
      )}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx)} onClose={closeCtx} />}
      {showHotkeys && <HotkeyDialog overrides={prefs.hotkeys} onChange={o => setPref('hotkeys', o)} onClose={() => setShowHotkeys(false)} />}
    </div>
  )
}
