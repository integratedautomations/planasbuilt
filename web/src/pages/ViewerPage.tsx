import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import '../viewer/viewer.css'
import { Icon } from '../ui/Icon'
import { api, post } from '../api'
import type { DocumentRevision, Project } from '../api'
import { clampRenderScale, loadPdf } from '../pdf'
import type { PDFDocumentProxy, PDFPageProxy } from '../pdf'
import { Thumbnails } from '../viewer/Thumbnails'
import type { PageAction } from '../viewer/Thumbnails'
import { usePanZoom } from '../viewer/usePanZoom'
import { loadLastView, saveLastView } from '../viewer/lastView'
import type { View } from '../viewer/usePanZoom'
import { clampDeviceScale, scaleDevice, scaleDevices, unscaleChange } from '../markups/deviceScale'
import { cableSettings } from '../markups/cables'
import { MarkupCanvas } from '../markups/MarkupCanvas'
import type { MarkupCanvasHandle } from '../markups/MarkupCanvas'
import { SelectionBar } from '../markups/SelectionBar'
import { detectStacks } from '../markups/stacks'
import type { Stack } from '../markups/stacks'
import { ToolRail } from '../markups/ToolRail'
import { ToolChest } from '../markups/ToolChest'
import { buildToolEntries, activeEntryId, entryCommand } from '../markups/toolEntries'
import type { ToolEntry } from '../markups/toolEntries'
import { ContextMenu } from '../markups/ContextMenu'
import type { MenuItem } from '../markups/ContextMenu'
import { MarkupPopup } from '../markups/MarkupInfo'
import { copyMarkup } from '../markups/copy'
import { pushSelection, selectAfterDelete } from '../markups/selectionHistory'
import { isSameDevice, replaceDevice } from '../markups/replaceDevice'
import type { ReplaceTarget } from '../markups/replaceDevice'
import { ReplaceDialog } from '../markups/ReplaceDialog'
import { markupBounds } from '../markups/selection'
import { DockZone } from '../viewer/DockZone'
import { usePrefs, setPref, getPrefs } from '../prefs/store'
import { pushRecent, toggleFavorite } from '../prefs/prefs'
import { assignCombo, commandForEvent, commandLabel as commandLabelOf, entryIdOfCommand, isDynamicCommand, isTypingTarget, keyName, parseCombo, resolveHotkeys } from '../prefs/hotkeys'
import { HotkeyDialog } from '../prefs/HotkeyDialog'
import { HotkeyRecorder } from '../prefs/HotkeyRecorder'
import { NavBar } from '../viewer/NavBar'
import { SnapControls } from '../viewer/SnapMenu'
import { usePageLines } from '../viewer/useSnapLines'
import { centerIfOffscreen, unionBox } from '../viewer/visibility'
import { OverlapPrompt } from '../markups/OverlapPrompt'
import { decideOverlap, replacePrompt, replaceTargets } from '../markups/placeReplace'
import { movePanel, panelsIn, PANEL_TITLES, propsVisible, setPanelOpen, setZoneSize } from '../prefs/layout'
import type { Dock, PanelId } from '../prefs/layout'
import { Areas, Layers, QuickStyle, SidePanel, sheetHeight } from '../markups/SidePanel'
import type { PanelTab, SheetSnap } from '../markups/SidePanel'
import { CalibrateDialog, ScaleControl } from '../markups/ScaleControl'
import type { PageScale } from '../markups/ScaleControl'
import { pathFromPoints } from '../markups/geometry'
import type { Pt } from '../markups/geometry'
import { legendRows as computeLegendRows, legendSettings, scopeOf } from '../markups/legend'
import type { LegendRow } from '../markups/legend'
import { annotationModeFor, setShowOriginalAnnots, showOriginalAnnots } from '../pdfio/annotVisibility'
import { areaBounds, areaPathIn, buildAreaIndex, deviceCounts, isArea, isSheetArea, parentChoices } from '../markups/areas'
import { useMarkups } from '../markups/useMarkups'
import { invalidatePdf, loadDocMeta, loadLayers, loadPdfBytes, loadProject, loadScales, loadSymbolSets } from '../offline/cache'
import { OfflineMissError } from '../offline/classify'
import { SyncIndicator } from '../offline/SyncIndicator'
import { useSyncStatus } from '../offline/hooks'
import { foreignNotice } from '../offline/owner'
import { discardForeign, flushWrites, queueScaleDelete, queueScalePut, retryAllFailed } from '../offline/sync'
import { AREA_STYLE, DEFAULT_STYLE, defaultStyleFor } from '../markups/types'
import type { Status } from '../markups/types'
import { defaultProductId, fieldDefsFor, productFields, productOptionLabel, productsFor } from '../catalog/catalog'
import { describeBlocked, gateStatus, lockedFor } from '../projectSettings'
import { CatalogContext, useCatalog } from '../catalog/useCatalog'
import { RoleContext } from '../roleContext'
import { can, isFieldOnly } from '../roles'
import { DeviceTypeEditor, draftOfType } from '../catalog/DeviceTypeEditor'
import { useSession } from '../settings/session'
import type { Layer, Markup, MarkupStyle, MarkupType, SymbolSet, Tool } from '../markups/types'
import { uuid } from '../uuid'
import { Avatars } from '../realtime/Avatars'
import { deletedToast } from '../realtime/handlers'
import { usePeers } from '../realtime/hooks'
import { viewportRect, viewForRect } from '../realtime/presence'
import type { Rect } from '../realtime/presence'
import { joinDocument, on as onSocket, sendPresence } from '../realtime/socket'
import { PdfMenu } from '../pdfio/PdfMenu'
import { PrintDialog } from '../pdfio/PrintDialog'
import { WindowPicker } from '../pdfio/WindowPicker'
import type { PrintWindow } from '../pdfio/printPlan'
import { buildPrintPdf } from '../pdfio/print'
import { markupsForPrint } from '../pdfio/printPlan'
import type { PrintOptions } from '../pdfio/printPlan'
import { printImages, renderPrintImages } from '../pdfio/printRaster'
import { buildSubset } from '../pdfio/pageSubset'
import { loadIcons } from '../pdfio/icons'
import { downloadBytes } from '../pdfio/download'
import { exportFileName } from '../pdfio/build'
import { ComparePanel } from '../revisions/ComparePanel'
import type { CompareRequest } from '../revisions/ComparePanel'
import { CompareView } from '../revisions/CompareView'
import type { CompareMode } from '../revisions/CompareView'
import { IssueRevisionDialog } from '../revisions/IssueRevisionDialog'
import { RevisionMenu } from '../revisions/RevisionMenu'
import { cloudChange } from '../revisions/clouds'
import type { CloudInput } from '../revisions/clouds'
import { deletePages, fetchRevisionPdf, insertPages, listRevisions, loadRevision, makeRevisionCurrent, moveOrder, replacePages, reorderPages, revisionName, rotatePages } from '../revisions/api'
import type { PageOpResult, RevisionDetail } from '../revisions/api'
import { MarkupsList } from '../schedule/MarkupsList'
import { MoreMenu, PlanSwitcher } from '../viewer/TopBar'
import { DeviceSizeControl } from '../viewer/DeviceSize'
import { MenuHeading, MenuItemBtn, MenuSep } from '../viewer/menuParts'
import { StatusChip } from '../viewer/StatusChip'
import { FloatingChip } from '../viewer/FloatingChip'
import type { Banner } from '../viewer/banners'
import type { ScreenBox } from '../markups/SelectionBar'
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
  const [show, setShow] = useState(() => { try { const v = localStorage.getItem(key); return v === null ? getPrefs().general.coverageDefault : v !== '0' } catch { return true } })
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
  /** Project cable defaults (slack %, drop ft). */
  const cableDefaults = useMemo(() => cableSettings(project), [project])
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
  const [searchParams, setSearchParams] = useSearchParams()
  const revParam = searchParams.get('rev')
  const compareParam = searchParams.get('compare')
  const revParamRef = useRef(revParam)
  revParamRef.current = revParam
  /** An earlier revision opened read-only (?rev=<id>). While it loads, the plan shows empty rather than the live markups. */
  const [revDetail, setRevDetail] = useState<RevisionDetail | null>(null)
  const viewingOld = !!revParam && !(revDetail?.id === revParam && revDetail.live)
  const [revList, setRevList] = useState<DocumentRevision[]>([])
  const [issueOpen, setIssueOpen] = useState(false)
  const [compareReq, setCompareReq] = useState<CompareRequest | null>(null)
  const [compareMode, setCompareMode] = useState<CompareMode>('side')
  const [showCompare, setShowCompare] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)
  const [printBusy, setPrintBusy] = useState('')
  /** Cancels the print preparation in flight. */
  const printAbort = useRef<AbortController | null>(null)
  /** Options kept while the dialog is hidden for the "Window" pick. */
  const [printDraft, setPrintDraft] = useState<PrintOptions | null>(null)
  const [pickingWindow, setPickingWindow] = useState(false)
  /** Pages picked in the Pages panel when Print was opened from it. */
  const [printSelected, setPrintSelected] = useState<number[]>([])
  const [printError, setPrintError] = useState('')
  const [pageBusy, setPageBusy] = useState('')
  const pickFile = useRef<HTMLInputElement>(null)
  const pendingPick = useRef<((f: File) => void) | null>(null)
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
  /** Focus mode: every panel and the top bar hidden (F or Esc brings them back). */
  const [focus, setFocus] = useState(false)
  /** The user closed Properties while this selection was active; it stays shut until the selection empties. */
  const [propsDismissed, setPropsDismissed] = useState(false)
  const sync = useSyncStatus()
  const [zoneTab, setZoneTab] = useState<Partial<Record<Dock, PanelId>>>({})
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [defaultStyle, setDefaultStyle] = useState<MarkupStyle>(DEFAULT_STYLE)
  const [stampText, setStampText] = useState('APPROVED')
  const [showOrig, setShowOrig] = useState(() => showOriginalAnnots(documentId))
  useEffect(() => { setShowOrig(showOriginalAnnots(documentId)) }, [documentId])
  const changeShowOrig = useCallback((v: boolean) => { setShowOriginalAnnots(documentId, v); setShowOrig(v) }, [documentId])
  const [layers, setLayers] = useState<Layer[]>([])
  const [symbolSetList, setSymbolSetList] = useState<SymbolSet[]>([])
  const [activeSetId, setActiveSetId] = useState<string | null>(null)
  const symbolSets = useMemo(() => new Map(symbolSetList.map(s => [s.id, s])), [symbolSetList])
  const { data: catalogData, catalog, reload: reloadCatalog } = useCatalog()
  const isAdmin = !!useSession()?.user.is_admin
  const [editTypeId, setEditTypeId] = useState<string | null>(null)
  const [newTypeSetId, setNewTypeSetId] = useState<string | null>(null)
  /** Device type / product the Device tool places; the product defaults to the type's default. */
  const [activeTypeId, setActiveTypeId] = useState<string | null>(null)
  const [activeProductId, setActiveProductId] = useState<string | null>(null)
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
  /** Plan-wide device size multiplier, stored on the document so everyone sees the same size. */
  const [deviceScale, setDeviceScaleState] = useState(1)
  const deviceScaleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const storeRef = useRef(store)
  storeRef.current = store
  /** The markups on screen: the live ones, or an earlier revision's frozen set. */
  const allMarkups = useMemo(() => (viewingOld
    ? new Map((revDetail && revDetail.id === revParam ? revDetail.markups : []).map(m => [m.id, m] as const))
    : store.markups), [viewingOld, revDetail, revParam, store.markups])

  const refreshRevs = useCallback(() => { listRevisions(documentId).then(l => { if (docIdRef.current === documentId) setRevList(l) }).catch(() => {}) }, [documentId])
  useEffect(() => { refreshRevs() }, [refreshRevs, reloadTick])
  /** The document being shown right now; answers for a document we already navigated away from are dropped. */
  const docIdRef = useRef(documentId)
  docIdRef.current = documentId
  const reloadScales = useCallback(() => {
    loadScales(documentId).then(({ data: rows }) => {
      if (docIdRef.current !== documentId) return
      setScales(new Map(rows.map(r => [r.page, { pointsPerFoot: r.points_per_foot, label: r.label }])))
    }).catch(() => {})
  }, [documentId])

  useEffect(() => {
    if (!revParam) { setRevDetail(null); return }
    let cancelled = false
    loadRevision(documentId, revParam).then(d => {
      if (cancelled) return
      if (d.live) { setSearchParams(p => { p.delete('rev'); return p }, { replace: true }); return }
      setRevDetail(d)
      setScales(new Map(d.scales.map(r => [r.page, { pointsPerFoot: r.points_per_foot, label: r.label }])))
    }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [documentId, revParam]) // eslint-disable-line react-hooks/exhaustive-deps
  const backToCurrent = useCallback(() => {
    setSearchParams(p => { p.delete('rev'); return p }, { replace: true })
    setRevDetail(null)
    reloadScales()
  }, [setSearchParams, reloadScales])
  /** "Set as current": restores an older revision as a new one, keeping the newer ones. */
  async function makeCurrent(r: DocumentRevision) {
    if (!canEditRole || pageBusy) return
    if (!confirm(`Make ${revisionName(r)} the current plan?

Its PDF, markups and scales are restored as a new revision. The present state is saved first as "Before restoring Rev ${r.revision}", and no revision is deleted.`)) return
    setPageBusy('Restoring revision…')
    try {
      await flushWrites()
      const res = await makeRevisionCurrent(documentId, r.id)
      backToCurrent()
      await invalidatePdf(documentId)
      await store.reload()
      reloadScales(); refreshRevs(); setSelectedIds([])
      setReloadTick(t => t + 1)
      setToast(`${res.label}: ${res.restored_markups} markup${res.restored_markups === 1 ? '' : 's'} restored.`)
    } catch (e) { setToast((e as Error).message) } finally { setPageBusy('') }
  }
  const viewRevision = useCallback((id: string | null) => {
    if (!id) { backToCurrent(); return }
    setSearchParams(p => { p.set('rev', id); return p })
  }, [backToCurrent, setSearchParams])

  // ---- live sync: presence out, remote changes in
  const canHover = useMediaQuery('(hover: hover)')
  const peers = usePeers()
  const peersHere = useMemo(() => peers.filter(p => p.page === pageNum), [peers, pageNum])
  const [toast, setToast] = useState('')
  const cursorRef = useRef<Pt | null>(null)
  const presenceRef = useRef({ page: 1, selection: [] as string[], viewport: null as Rect | null, marquee: null as Rect | null })
  const peersRef = useRef(peers)
  peersRef.current = peers
  const knownMarkups = useRef(new Map<string, { tag?: string; type: string }>())
  for (const m of store.markups.values()) knownMarkups.current.set(m.id, { tag: m.tag, type: m.type })
  const pendingCenter = useRef<{ page: number; x: number; y: number } | null>(null)
  const pendingFit = useRef<{ page: number; rect: Rect } | null>(null)

  useEffect(() => { joinDocument(documentId); return () => joinDocument(null) }, [documentId])
  useEffect(() => {
    if (presenceRef.current.page !== pageNum) cursorRef.current = null // old page's coordinates
    presenceRef.current = { ...presenceRef.current, page: pageNum, selection: selectedIds, marquee: null }
    sendPresence({ ...presenceRef.current, cursor: cursorRef.current })
  }, [pageNum, selectedIds])
  const onMarquee = useCallback((r: Rect | null) => {
    presenceRef.current = { ...presenceRef.current, marquee: r }
    sendPresence({ ...presenceRef.current, cursor: cursorRef.current })
  }, [])
  const onCursor = useCallback((p: Pt | null) => {
    cursorRef.current = p
    sendPresence({ ...presenceRef.current, cursor: p })
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(t)
  }, [toast])
  // What this role may do (src/roles.ts). Field and sub roles get a read-only canvas (no drawing tools, no drag or transform
  // handles) but keep editing device fields, status, notes and photos through `fieldsOnly`. While the project loads nothing is locked.
  const role = project?.role
  const canEditRole = can(role, 'plans.edit')
  // A locked project can only be changed by its admins (the server enforces it too).
  const projectLocked = lockedFor(role, { locked: project?.settings?.locked === true })
  const fieldsOnly = isFieldOnly(role) && !viewingOld && !projectLocked
  const readOnly = (!!role && !can(role, 'markup.geometry')) || viewingOld || projectLocked
  const activeTool: Tool = spaceHeld ? 'pan' : tool

  const syncStage = useCallback((v: View) => {
    const el = viewportRef.current
    if (el) {
      const vp = viewportRect(v, { width: el.clientWidth, height: el.clientHeight })
      presenceRef.current = { ...presenceRef.current, viewport: vp }
      sendPresence({ ...presenceRef.current, cursor: cursorRef.current })
    }
    const stage = markupRef.current?.stage()
    if (!stage) return
    stage.position({ x: v.x, y: v.y })
    stage.scale({ x: v.zoom, y: v.zoom })
    stage.batchDraw()
  }, [])

  const lastViewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const rememberView = (v: View) => {
    clearTimeout(lastViewTimer.current)
    const doc = documentId, pg = pageNum
    lastViewTimer.current = setTimeout(() => saveLastView(doc, pg, v), 400)
  }
  const pageSize = page ? page.getViewport({ scale: 1 }) : null
  const { zoom, settledZoom, fit, zoomBy, centerOn, view, setView } = usePanZoom(viewportRef, stageRef,
    pageSize ? { width: pageSize.width, height: pageSize.height } : null, {
      shouldPan: () => { const owned = consumedRef.current; consumedRef.current = false; return !owned },
      onPinchStart: () => markupRef.current?.cancelGesture(),
      holdPan: () => !!markupRef.current?.isPlacing(),
      initialView: () => (getPrefs().general.openAt === 'last' ? loadLastView(documentId, pageNum) : null),
      onView: v => { syncStage(v); rememberView(v) },
    })
  useEffect(() => { syncStage(view.current) })

  useEffect(() => {
    let cancelled = false
    loadDocMeta(documentId).then(r => { if (!cancelled) { setMeta(r.data); setDeviceScaleState(clampDeviceScale(r.data.device_scale ?? 1)) } }).catch(e => { if (!cancelled) setError(e.message) })
    loadProject(projectId).then(r => { if (!cancelled) setProject(r.data) }).catch(() => {})
    loadLayers(projectId).then(r => { if (!cancelled) setLayers(r.data) }).catch(() => {})
    loadSymbolSets().then(({ data: sets }) => {
      if (cancelled) return
      setSymbolSetList(sets)
      setActiveSetId(id => id ?? sets[0]?.id ?? null)
    }).catch(() => {})
    if (!revParam) reloadScales() // guarded by docIdRef: a stale answer for another document is ignored
    let task: ReturnType<typeof loadPdf> | null = null
    setNotCached(false)
    ;(revParam ? Promise.resolve(undefined) : loadDocMeta(documentId).then(r => r.data.revisions[0]?.id, () => undefined)).then(revisionId => {
      if (cancelled) throw new Error('cancelled')
      if (revParam) return fetchRevisionPdf(documentId, revParam)
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
      void task?.destroy()
      if (e instanceof OfflineMissError) setNotCached(true)
      else setError(`Could not open PDF: ${e.message}`)
    })
    return () => { cancelled = true; task?.destroy() }
  }, [documentId, projectId, reloadTick, revParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // Things other people changed (or that we missed while disconnected): refetch the lists we show.
  useEffect(() => {
    const offs = [
      onSocket('device_scale', (m: { deviceScale?: number }) => setDeviceScaleState(clampDeviceScale(m.deviceScale ?? 1))),
      onSocket('scales', () => { loadDocMeta(documentId).then(r => { if (!r.fromCache) setDeviceScaleState(clampDeviceScale(r.data.device_scale ?? 1)) }).catch(() => {}); loadScales(documentId).then(({ data: rows }) =>
        setScales(new Map(rows.map(r => [r.page, { pointsPerFoot: r.points_per_foot, label: r.label }])))).catch(() => {}) }),
      // A new revision was uploaded (or we missed one while offline): drop the stored PDF and reload.
      onSocket('revision', () => {
        refreshRevs()
        loadDocMeta(documentId).then(r => {
          const latest = r.data.revisions[0]
          if (r.fromCache || !latest || latest.id === loadedRevision.current || revParamRef.current) return
          if (latest.kind === 'restore') {
            setToast(`${latest.label || `Rev ${latest.revision}`}: the plan was restored; reloading.`)
            void invalidatePdf(documentId).then(() => { void storeRef.current.reload(); reloadScales(); setReloadTick(t => t + 1) })
            return
          }
          if (latest.kind === 'issued') { // same PDF and markups: only the revision list changed
            setToast(`Rev ${latest.revision} was issued${latest.label ? `: ${latest.label}` : ''}.`)
            return
          }
          setToast(`Revision ${latest.revision} was uploaded; reloading the plan.`)
          void invalidatePdf(documentId).then(() => { void storeRef.current.reload(); reloadScales(); setReloadTick(t => t + 1) })
        }).catch(() => {})
      }),
      onSocket('markups_reset', () => { void storeRef.current.reload(); setSelectedIds([]) }),
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
  }, [documentId, projectId, refreshRevs, reloadScales])

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    let got: PDFPageProxy | null = null
    pdf.getPage(pageNum).then(p => {
      got = p
      if (!cancelled) { setPage(p); setPageSrc(pdf) }
    })
    setSelectedIds([])
    // Free the old page's operator list and decoded images (pdf.js defers this while a render is running).
    return () => { cancelled = true; got?.cleanup() }
  }, [pdf, pageNum])

  // The visible canvas is not tracked by React once removed: release its bitmap memory (matters on iOS).
  useEffect(() => () => { const c = canvasRef.current; if (c) c.width = c.height = 0 }, [])

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
    const task = page.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport: vp, annotationMode: annotationModeFor(showOrig) })
    task.promise.then(() => {
      const c = canvasRef.current
      if (!c) return
      c.width = off.width
      c.height = off.height
      c.getContext('2d')!.drawImage(off, 0, 0)
    }).catch(() => { /* cancelled */ }).finally(() => {
      off.width = off.height = 0 // release the offscreen bitmap now rather than at GC
      page.cleanup() // drop the operator list and decoded images; the next render re-parses
    })
    return () => task.cancel()
  }, [page, settledZoom, showOrig])

  // A markup is hidden/locked if its custom layer or its symbol set's layer is
  const flagged = (flags: Set<string>, m: Markup) =>
    flags.has(m.layer_id ?? '') || (!!m.symbol_set_id && flags.has(`set:${m.symbol_set_id}`))
  const pageMarkups = useMemo(
    () => [...allMarkups.values()].filter(m => m.page === pageNum && !flagged(hidden, m)),
    [allMarkups, pageNum, hidden]) // eslint-disable-line react-hooks/exhaustive-deps
  // Area hierarchy is built from every area (even on hidden layers or with outlines hidden) so paths stay reliable.
  const areaIndex = useMemo(() => buildAreaIndex([...allMarkups.values()].filter(isArea)), [allMarkups])
  const pageAreas = useMemo(() => [...areaIndex.byId.values()].filter(a => a.page === pageNum), [areaIndex, pageNum])
  const areaPaths = useMemo(() => new Map(pageAreas.map(a => [a.id, areaPathIn(areaIndex, a)])), [areaIndex, pageAreas])
  const counts = useMemo(() => deviceCounts(areaIndex, allMarkups.values()), [areaIndex, allMarkups])
  const canvasMarkups = useMemo(() => {
    const list = showAreas ? pageMarkups : pageMarkups.filter(m => m.type !== 'area')
    return scaleDevices(list, deviceScale)
  }, [pageMarkups, showAreas, deviceScale])
  /** Edits made on the scaled devices go back to the store as real (unscaled) geometry. */
  const canvasCommit = useCallback((change: Parameters<typeof store.commit>[0]) =>
    store.commit(unscaleChange(change, deviceScale, id => allMarkups.get(id))), [store, deviceScale, allMarkups])
  /** Markups kept from an earlier revision whose pages the current PDF no longer has. */
  const orphaned = useMemo(() => {
    const pages = new Set<number>()
    let count = 0
    if (pdf && !viewingOld) for (const m of allMarkups.values()) if (m.page > pdf.numPages) { pages.add(m.page); count++ }
    return { count, pages: [...pages].sort((a, b) => a - b) }
  }, [pdf, allMarkups, viewingOld])
  const stackIndex = useMemo(() => detectStacks(pageMarkups), [pageMarkups])
  /** Live rows for each legend on this page, counted over all markups (even on hidden layers). */
  const legendRowsById = useMemo(() => {
    const out = new Map<string, LegendRow[]>()
    for (const m of pageMarkups) {
      if (m.type !== 'legend') continue
      const s = legendSettings(m)
      out.set(m.id, computeLegendRows(allMarkups.values(), catalog, scopeOf(s.scope, m.page), { groupBy: s.groupBy, symbolSets, areaIndex }))
    }
    return out
  }, [pageMarkups, allMarkups, catalog, symbolSets, areaIndex])
  const lockedIds = useMemo(
    () => new Set(pageMarkups.filter(m => flagged(locked, m)).map(m => m.id)),
    [pageMarkups, locked]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(
    () => selectedIds.map(id => allMarkups.get(id)).filter((m): m is Markup => !!m),
    [selectedIds, allMarkups])

  /** Jump to a markup from the list: switch document/page if needed, then select and center it. */
  const jumpTo = useCallback((t: JumpTarget) => {
    pendingJump.current = { id: t.id, page: t.page }
    if (t.documentId !== documentId) navigate(`/projects/${projectId}/documents/${t.documentId}`)
    else { setPageNum(t.page); setJumpTick(n => n + 1) }
    if (isPhone) setShowList(false)
  }, [documentId, projectId, navigate, isPhone])

  // Deep link from the Devices page: ?markup=<id>&page=<n> selects and zooms to that device, then the params are dropped.
  useEffect(() => {
    const id = searchParams.get('markup')
    if (!id) return
    const pg = Number(searchParams.get('page'))
    pendingJump.current = { id, page: Number.isInteger(pg) && pg >= 1 ? pg : 1 }
    setPageNum(pendingJump.current.page)
    setJumpTick(n => n + 1)
    setSearchParams(sp => { const n = new URLSearchParams(sp); n.delete('markup'); n.delete('page'); return n }, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const j = pendingJump.current
    if (!j || !page || !pdf || pageSrc !== pdf || pdfFor !== documentId || pageNum !== j.page || page.pageNumber !== j.page || !store.loaded) return
    const m = allMarkups.get(j.id)
    if (!m || m.document_id !== documentId) return
    pendingJump.current = null
    setSelectedIds([m.id])
    const a = anchorOf(m)
    centerOn(a.x, a.y, Math.max(view.current.zoom, 1))
  }, [page, pageSrc, pdf, pdfFor, documentId, pageNum, store.loaded, allMarkups, jumpTick]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Avatar tap: go to that person's page and centre on their cursor or selection. */
  const jumpToPeer = useCallback((p: { page: number | null; cursor: Pt | null; selection: string[]; viewport?: Rect | null }) => {
    const sel = p.selection.map(id => allMarkups.get(id)).find(m => !!m)
    const at = p.cursor ?? (sel ? anchorOf(sel) : null)
    const target = p.page ?? pageNum
    if (p.viewport) pendingFit.current = { page: target, rect: p.viewport }
    else if (at) pendingCenter.current = { page: target, x: at.x, y: at.y }
    if (target !== pageNum) setPageNum(Math.min(Math.max(1, target), pageCount || target))
    setJumpTick(n => n + 1)
  }, [allMarkups, pageNum]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = pendingFit.current
    const el = viewportRef.current
    if (!f || !el || !page || pageSrc !== pdf || page.pageNumber !== f.page) return
    pendingFit.current = null
    const v = viewForRect(f.rect, { width: el.clientWidth, height: el.clientHeight })
    if (v) setView(v)
  }, [page, pageSrc, pdf, jumpTick]) // eslint-disable-line react-hooks/exhaustive-deps
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
  // Desktop: Properties opens by itself with a selection (on its own tab) and a dismissal lasts until the selection empties
  useEffect(() => {
    if (!hasSelection) { setPropsDismissed(false); return }
    if (!isPhone) setZoneTab(z => ({ ...z, [getPrefs().layout.panels.props.dock]: 'props' }))
  }, [hasSelection, isPhone])
  const propsOn = propsVisible({ hasSelection, pinned: prefs.propsPinned, manualOpen: layout.panels.props.open, dismissed: propsDismissed })
  /** The layout as shown: Properties' open state is derived (auto-open / pin), the rest is as saved. */
  const shownLayout = useMemo(() => setPanelOpen(layout, 'props', propsOn), [layout, propsOn])

  // Keep the selected markup visible above the sheet.
  const selectedKey = selectedIds.join(',')
  /** Earlier selections (newest last), so deleting a markup can go back to the one selected before it. */
  const selHistory = useRef<string[][]>([])
  useEffect(() => { selHistory.current = pushSelection(selHistory.current, selectedIds) }, [selectedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { selHistory.current = [] }, [documentId, pageNum])
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
  // Vector lines of the plan page, for snapping (off when the master or PDF snap switch is off)
  const snapLines = usePageLines(page, `${documentId}:${revParam ?? loadedRevision.current ?? 'cur'}:${pageNum}`, prefs.snap.on && prefs.snap.pdf)

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
    const existing = n.id ? allMarkups.get(n.id) : undefined
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

  /** Pans (keeping the zoom) so the given markups are in view; does nothing when they already are. */
  const revealMarkups = useCallback((ids: string[]) => {
    const vp = viewportRef.current
    if (!vp || !ids.length) return
    const box = unionBox(ids.map(id => store.markups.get(id)).filter((m): m is Markup => !!m).map(markupBounds))
    if (!box) return
    const at = centerIfOffscreen(view.current, { width: vp.clientWidth, height: vp.clientHeight }, box)
    if (at) centerOn(at.x, at.y)
  }, [store, centerOn, view])

  const deleteSelected = useCallback(() => {
    if (readOnly) return
    if (!selected.length) return
    if (selected.length > 1 && getPrefs().general.confirmMultiDelete && !confirm(`Delete ${selected.length} markups?`)) return
    const next = selectAfterDelete({ history: selHistory.current, deleted: selected, remaining: store.markups.values() })
    store.commit(selected.map(m => ({ before: m, after: null })))
    setSelectedIds(next)
    revealMarkups(next)
  }, [readOnly, selected, store, revealMarkups])

  /** Adds one more device of the stack's set at the same spot; the server numbers it. One undo step. */
  const addToStack = useCallback((stack: Stack) => {
    if (readOnly) return
    const top = stack.members[stack.members.length - 1]
    const m: Markup = {
      id: uuid(), document_id: top.document_id, page: top.page, type: 'device', geometry: { ...top.geometry },
      style: { ...top.style }, text: '', layer_id: top.layer_id, symbol_set_id: top.symbol_set_id,
      device_type_id: top.device_type_id ?? null, product_id: top.product_id ?? null, tag: '', status: 'planned',
      fields: productFields(top.product_id ? catalog.products.get(top.product_id) : undefined),
    }
    store.commit([{ before: null, after: m }])
    setSelectedIds([m.id])
  }, [readOnly, store, catalog])

  /** Moves one member 1.5 diameters to the right so it stands alone. */
  const pullOut = useCallback((m: Markup) => {
    if (readOnly || !('width' in m.geometry)) return
    const d = Math.min(m.geometry.width, m.geometry.height)
    store.commit([{ before: m, after: { ...m, geometry: { ...m.geometry, x: m.geometry.x + d * 1.5 } } }])
  }, [readOnly, store])

  const deleteStack = useCallback((stack: Stack) => {
    if (readOnly) return
    const next = selectAfterDelete({ history: selHistory.current, deleted: stack.members, remaining: store.markups.values() })
    store.commit(stack.members.map(m => ({ before: m, after: null })))
    setSelectedIds(next)
    revealMarkups(next)
  }, [readOnly, store, revealMarkups])

  const updateSelected = useCallback((patch: (m: Markup) => Markup, mergeKey: string) => {
    if (readOnly && !fieldsOnly) return
    // Field and sub users may only change fields and status, whatever the panel sends.
    const apply = fieldsOnly ? (m: Markup) => { const n = patch(m); return { ...m, fields: n.fields, status: n.status } } : patch
    let changes = selected.map(m => ({ before: m, after: apply(m) }))
    // Required fields per status (Settings > Project): devices missing something keep their status and the user is told what is needed.
    const moving = changes.filter(c => (c.after.status ?? '') !== (c.before.status ?? ''))
    if (moving.length) {
      const status = moving[0].after.status ?? ''
      const defsOf = (m: Markup) => fieldDefsFor(m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined, m.device_type_id ? catalog.types.get(m.device_type_id) : undefined)
      const { blocked } = gateStatus(moving.map(c => ({ ...c.before, fields: c.after.fields, tag: c.after.tag })), status, defsOf)
      if (blocked.length) {
        const stop = new Set(blocked.map(b => b.markup.id))
        changes = changes.filter(c => !stop.has(c.before.id))
        setToast(describeBlocked(status, blocked))
      }
    }
    if (changes.length) store.commit(changes, `${mergeKey}:${selectedIds.join(',')}`)
  }, [readOnly, fieldsOnly, selected, selectedIds, store, symbolSets, catalog])

  const [replacing, setReplacing] = useState(false)
  /** Tool chest entry whose hotkey is being recorded. */
  const [hkEntry, setHkEntry] = useState<ToolEntry | null>(null)
  const selectedDevices = useMemo(() => selected.filter(m => m.type === 'device'), [selected])
  /** Swaps the selected devices for another set / type / product as one undo step. */
  const replaceSelected = useCallback((t: ReplaceTarget) => {
    setReplacing(false)
    if (readOnly) return
    const change = selectedDevices.filter(m => !isSameDevice(m, t) || t.productId !== undefined).map(m => ({ before: m, after: replaceDevice(m, t, symbolSets, catalog) }))
      .filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after))
    store.commit(change)
  }, [readOnly, selectedDevices, symbolSets, catalog, store])

  /** A device of another type was placed on an existing one: replace per the saved choice, ask, or place both. */
  const [overlap, setOverlap] = useState<{ targets: Markup[]; placed: Markup; message: string } | null>(null)
  const replaceUnder = useCallback((targets: Markup[], placed: Markup) => {
    const t: ReplaceTarget = { setId: placed.symbol_set_id ?? '', typeId: placed.device_type_id ?? null, productId: placed.product_id ?? undefined }
    const change = targets.map(m => ({ before: m, after: replaceDevice(m, t, symbolSets, catalog) })).filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after))
    store.commit(change)
    setSelectedIds(targets.map(m => m.id))
  }, [symbolSets, catalog, store])
  const placeBoth = useCallback((placed: Markup) => { store.commit([{ before: null, after: placed }]); setSelectedIds([placed.id]) }, [store])
  const onDeviceOverlap = useCallback((shownTarget: Markup, shownPlaced: Markup) => {
    const target = allMarkups.get(shownTarget.id) ?? shownTarget
    const placed = scaleDevice(shownPlaced, 1 / deviceScale)
    const targets = replaceTargets(target, stackIndex)
    const decision = decideOverlap(getPrefs().replaceOnOverlap, true)
    if (decision === 'both') return false
    if (decision === 'replace') { replaceUnder(targets, placed); return true }
    const oldType = target.device_type_id ? catalog.types.get(target.device_type_id)?.name : undefined
    const newType = placed.device_type_id ? catalog.types.get(placed.device_type_id)?.name : symbolSets.get(placed.symbol_set_id ?? '')?.name
    setOverlap({ targets, placed, message: replacePrompt(targets, oldType ?? symbolSets.get(target.symbol_set_id ?? '')?.name ?? '', newType ?? '') })
    return true
  }, [stackIndex, catalog, symbolSets, replaceUnder, allMarkups, deviceScale])
  const answerOverlap = (choice: 'replace' | 'both' | 'cancel', remember: boolean) => {
    const o = overlap
    setOverlap(null)
    if (!o) return
    if (remember && choice !== 'cancel') setPref('replaceOnOverlap', choice)
    if (choice === 'replace') replaceUnder(o.targets, o.placed)
    else if (choice === 'both') placeBoth(o.placed)
  }

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

  // ---- revisions, page tools, print
  const scaleMap = useCallback(() => new Map([...scales].map(([p, sc]) => [p, sc.pointsPerFoot] as const)), [scales])

  /** Changes the plan's device size: shown at once, saved (and pushed to everyone) shortly after the last change. */
  const changeDeviceScale = useCallback((v: number) => {
    if (readOnly) return
    const next = clampDeviceScale(v)
    setDeviceScaleState(next)
    if (deviceScaleTimer.current) clearTimeout(deviceScaleTimer.current)
    deviceScaleTimer.current = setTimeout(() => {
      api(`/documents/${documentId}`, { method: 'PATCH', body: JSON.stringify({ device_scale: next }) }).catch(e => setToast(`Could not save the device size: ${(e as Error).message}`))
    }, 300)
  }, [readOnly, documentId])
  const deviceDisplay = { deviceScale, onDeviceScale: changeDeviceScale, deviceScaleReadOnly: readOnly }

  /** The PDF being shown, as fresh bytes (pdf.js takes ownership of the ones it was given). */
  const currentPdfBytes = useCallback(
    () => (revParam ? fetchRevisionPdf(documentId, revParam) : loadPdfBytes(documentId, loadedRevision.current)), [documentId, revParam])

  const jumpToSpot = useCallback((p: number, x: number, y: number) => {
    pendingCenter.current = { page: p, x, y }
    setPageNum(Math.min(Math.max(1, p), pageCount || p))
    setJumpTick(n => n + 1)
  }, [pageCount])

  const makeClouds = useCallback(async (inputs: CloudInput[], layerName: string) => {
    if (readOnly) throw new Error('Clouds can only be added to the current plan')
    let layer = layers.find(l => l.name === layerName)
    if (!layer) {
      layer = await post<Layer>(`/projects/${projectId}/layers`, { name: layerName, color: '#e03131' })
      setLayers(ls => [...ls, layer!])
    }
    store.commit(cloudChange(inputs, { documentId, layerId: layer.id, newId: uuid }))
  }, [readOnly, layers, projectId, documentId, store])

  async function afterPageOp(res: PageOpResult) {
    await invalidatePdf(documentId)
    await store.reload()
    reloadScales()
    refreshRevs()
    setSelectedIds([])
    setPageNum(n => Math.min(Math.max(1, res.mapping[n - 1] ?? Math.min(n, res.page_count)), res.page_count))
    setReloadTick(t => t + 1)
    setToast(`Rev ${res.revision}: ${res.label || 'plan updated'}${res.deleted_markups ? ` (${res.deleted_markups} markup${res.deleted_markups === 1 ? '' : 's'} removed; kept in the earlier revision)` : ''}`)
  }
  async function runPageTool(fn: () => Promise<PageOpResult>) {
    if (readOnly || pageBusy) return
    setPageBusy('Updating pages…')
    try {
      await flushWrites() // unsent edits carry the old page numbers
      await afterPageOp(await fn())
    } catch (e) { setToast((e as Error).message) } finally { setPageBusy('') }
  }
  const choosePdf = (then: (f: File) => void) => { pendingPick.current = then; pickFile.current?.click() }
  async function extractPages(pages: number[]) {
    setPageBusy('Extracting pages…')
    try {
      const bytes = await buildSubset({
        pdfBytes: await currentPdfBytes(), pages, markups: scaleDevices(allMarkups.values(), deviceScale), symbolSets, scales: scaleMap(),
        icons: await loadIcons(symbolSets.values(), catalog.types.values()), mode: 'annotate', showCones, catalog,
      })
      downloadBytes(bytes, exportFileName(meta?.name ?? 'plan', `page${pages.length === 1 ? '' : 's'}-${pages.slice(0, 6).join('_')}${pages.length > 6 ? '_etc' : ''}`))
    } catch (e) { setToast(`Could not extract: ${(e as Error).message}`) } finally { setPageBusy('') }
  }
  const pageList = (pages: number[]) => (pages.length === 1 ? `page ${pages[0]}` : `${pages.length} pages`)
  const onPageAction = (a: PageAction) => {
    switch (a.type) {
      case 'extract': void extractPages(a.pages); break
      case 'print': setPrintSelected(a.pages); setPrintError(''); setPrintDraft(null); setPrintOpen(true); break
      case 'rotate': void runPageTool(() => rotatePages(documentId, a.pages)); break
      case 'delete':
        if (confirm(`Delete ${pageList(a.pages)}? Their markups leave the plan but stay in the previous revision, which you can still open.`))
          void runPageTool(() => deletePages(documentId, a.pages))
        break
      case 'move': void runPageTool(() => reorderPages(documentId, moveOrder(pageCount, a.from, a.to))); break
      case 'insert': choosePdf(f => { void runPageTool(() => insertPages(documentId, f, a.at)) }); break
      case 'replace': choosePdf(f => { void runPageTool(() => replacePages(documentId, f, a.pages.join(','))) }); break
    }
  }
  const pageToolsOn = canEditRole && !viewingOld

  const printArgs = async () => ({
    documentId, markups: scaleDevices(allMarkups.values(), deviceScale), symbolSets, deviceTypes: catalog.types.values(), scales: scaleMap(), showCones, catalog,
    pdfBytes: revParam ? await fetchRevisionPdf(documentId, revParam) : undefined, showOriginalAnnots: showOrig,
  })

  /** Renders the chosen pages to images and hands them to the browser's print dialog (printer and paper are picked there). */
  async function doPrint(o: PrintOptions, pages: number[]) {
    printAbort.current?.abort()
    const ctl = new AbortController()
    printAbort.current = ctl
    setPrintBusy('Preparing pages…'); setPrintError('')
    try {
      const raster = await renderPrintImages(await printArgs(), o, pages, (d, t) => { if (!ctl.signal.aborted) setPrintBusy(`Preparing page ${d} of ${t}…`) }, ctl.signal)
      await printImages(raster, o, meta?.name ?? 'Plan', ctl.signal)
      if (!ctl.signal.aborted) closePrint()
    } catch (e) {
      if (!ctl.signal.aborted) setPrintError((e as Error).message)
    } finally {
      if (printAbort.current === ctl) { printAbort.current = null; setPrintBusy('') }
    }
  }

  /** Cancel / close: stops any preparation in flight so nothing prints. */
  function closePrint() {
    printAbort.current?.abort()
    printAbort.current = null
    setPrintBusy('')
    setPrintOpen(false); setPrintDraft(null); setPickingWindow(false)
  }

  function finishWindowPick(w: PrintWindow | null) {
    setPickingWindow(false)
    setPrintDraft(d => (d ? (w ? { ...d, range: 'window', window: w } : d.window ? d : { ...d, range: 'all' }) : d))
  }

  /** The earlier route: build a print-ready PDF and download it. */
  async function savePrintPdf(o: PrintOptions, pages: number[]) {
    setPrintBusy('Building PDF…'); setPrintError('')
    try {
      const a = await printArgs()
      const bytes = await buildPrintPdf({ ...a, markups: markupsForPrint(a.markups, o) ?? [] }, {
        range: 'custom', custom: pages.join(','), fit: o.fit, includeMarkups: o.includeMarkups, hiddenLayers: [],
      }, pageNum, pageCount)
      downloadBytes(bytes, exportFileName(meta?.name ?? 'plan', 'print'))
      setPrintOpen(false)
    } catch (e) { setPrintError((e as Error).message) } finally { setPrintBusy('') }
  }

  // Project page links here with ?compare=<older revision>: open the Compare panel against the newest one.
  useEffect(() => {
    if (!compareParam || revList.length < 2) return
    setPanel('compare', true)
    setSearchParams(p => { p.delete('compare'); return p }, { replace: true })
  }, [compareParam, revList.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const toolEntries = useMemo(() => buildToolEntries(symbolSetList, catalogData.device_types), [symbolSetList, catalogData.device_types])
  // The symbol set itself is no longer a tool (only its device types are): drop favorites and recents that pointed at one
  useEffect(() => {
    const p = getPrefs()
    if (p.favorites.some(id => id.startsWith('set:'))) setPref('favorites', p.favorites.filter(id => !id.startsWith('set:')))
    if (p.recent.some(id => id.startsWith('set:'))) setPref('recent', p.recent.filter(id => !id.startsWith('set:')))
  }, [prefs.favorites, prefs.recent])
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
    if (e.tool === 'device') { setActiveTypeId(e.typeId ?? null); setActiveProductId(e.typeId ? defaultProductId(catalog, e.typeId) : null) }
    chooseTool(e.tool, e.shape ?? null)
    if (e.tool !== 'select' && e.tool !== 'pan') setPref('recent', pushRecent(getPrefs().recent, e.id))
  }, [chooseTool, catalog])

  const setPanel = useCallback((id: PanelId, open: boolean) => {
    if (isPhone) {
      if (id === 'pages') setShowThumbs(open); else if (id === 'markups') setShowList(open); else if (id === 'compare') setShowCompare(open)
      else if (id === 'props' || id === 'layers' || id === 'areas') {
        setShowPanel(open)
        if (open) setPanelTab(id === 'props' ? 'props' : id)
      }
      return
    }
    const l = getPrefs().layout
    if (id === 'props') {
      // Open = keep it open by hand; close = unpin and keep it shut until the selection changes
      if (!open) { setPropsDismissed(true); if (getPrefs().propsPinned) setPref('propsPinned', false) } else setPropsDismissed(false)
    }
    setPref('layout', setPanelOpen(l, id, open))
    if (open) setZoneTab(z => ({ ...z, [l.panels[id].dock]: id }))
  }, [isPhone])
  const panelOpen = (id: PanelId) =>
    isPhone
      ? (id === 'pages' ? showThumbs : id === 'markups' ? showList : id === 'compare' ? showCompare
        : id === 'props' ? showPanel && panelTab !== 'layers' && panelTab !== 'areas' : id === 'layers' || id === 'areas' ? showPanel && panelTab === id : false)
      : id === 'props' ? propsOn : (layout.panels[id]?.open ?? false)
  /** Left dock / right dock as a whole (the top bar's sidebar buttons). */
  const dockOpen = (d: Dock) => panelsIn(shownLayout, d).length > 0
  const toggleDock = (d: Dock) => {
    const l = getPrefs().layout
    const ids = (Object.keys(l.panels) as PanelId[]).filter(id => l.panels[id].dock === d)
    if (dockOpen(d)) {
      let next = l
      for (const id of ids) next = setPanelOpen(next, id, false)
      if (d === l.panels.props.dock) { setPropsDismissed(true); if (getPrefs().propsPinned) setPref('propsPinned', false) }
      setPref('layout', next)
    } else {
      const first: PanelId = d === 'left' ? 'tools' : l.panels.props.dock === d ? 'props' : ids[0]
      if (!first) return
      let next = setPanelOpen(l, first, true)
      if (d === 'left') next = setPanelOpen(next, 'pages', next.panels.pages.dock === 'left')
      setPropsDismissed(false)
      setPref('layout', next)
      setZoneTab(z => ({ ...z, [d]: first }))
    }
  }
  const openPanel = (id: PanelId) => { if (id === 'props' && !isPhone) setPropsDismissed(false); else setPanel(id, true) }
  const togglePanel = (id: PanelId) => setPanel(id, !panelOpen(id))
  const closeCtx = useCallback(() => setCtx(null), [])

  /** Runs a hotkey command. Returns false when the id is not handled. */
  const runCommand = (cmd: string): boolean => {
    if (isDynamicCommand(cmd)) {
      const entry = entryMap.get(entryIdOfCommand(cmd) ?? '')
      if (entry && (!readOnly || entry.tool === 'select' || entry.tool === 'pan')) pickEntry(entry)
      return true
    }
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
      case 'view.focus': setFocus(f => !f); return true
      case 'panel.layers': togglePanel('layers'); return true
      case 'edit.escape': if (focus) { setFocus(false); return true }; markupRef.current?.cancelDraft(); setSelectedIds([]); setTool('select'); setShapeLock(null); return true
      case 'edit.finish': markupRef.current?.finishDraft(); return true
      case 'snap.toggle': setPref('snap', { ...getPrefs().snap, on: !getPrefs().snap.on }); return true
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
      case 'panel.compare': togglePanel('compare'); return true
      case 'panel.areas': togglePanel('areas'); return true
      case 'file.print': setPrintSelected([]); setPrintError(''); setPrintDraft(null); setPrintOpen(true); return true
      default: return false
    }
  }

  // One key listener for every command in the hotkey registry; ignored while typing or while a menu/dialog is open
  const runRef = useRef(runCommand)
  runRef.current = runCommand
  const modalOpen = showHotkeys || !!hkEntry || !!editTypeId || !!newTypeSetId || !!overlap || !!ctx || replacing || printOpen || issueOpen || !!compareReq
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

  const drawStyleTool = !['select', 'pan', 'device', 'calibrate', 'legend'].includes(activeTool)
  const activeSet = activeSetId ? symbolSets.get(activeSetId) : undefined
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  /** Screen box (viewport-relative) of the selection, read every frame by the selection bar. */
  const selAnchor = useCallback((): ScreenBox => {
    const sel = selectedRef.current
    const box = unionBox(sel.map(markupBounds))
    if (!box) return null
    const v = view.current
    return { left: v.x + box.x * v.zoom, top: v.y + box.y * v.zoom, right: v.x + (box.x + box.width) * v.zoom, bottom: v.y + (box.y + box.height) * v.zoom }
  }, [view])
  const setStatusOnSelected = useCallback((st: Status) => { updateSelected(m => ({ ...m, status: st }), 'status') }, [updateSelected])

  /** Every notice, collapsed into the status chip (see viewer/banners). */
  const banners: Banner[] = []
  if (sync.foreign) banners.push({ id: 'foreign', level: 'bad', text: foreignNotice(sync.foreign), action: { label: 'Discard', danger: true, run: () => { const f = sync.foreign!; if (confirm(`Discard ${f.count} unsent change${f.count === 1 ? '' : 's'} from ${f.name}? This cannot be undone.`)) void discardForeign() } } })
  if (projectLocked) banners.push({ id: 'locked', level: 'warn', text: 'This project is locked. Only admins can make changes.' })
  if (sync.authRequired) banners.push({ id: 'authRequired', level: 'bad', text: 'Your session expired. Sign in again; queued changes are kept on this device.' })
  if (sync.failed > 0) banners.push({ id: 'failed', level: 'bad', text: `${sync.failed} change${sync.failed === 1 ? '' : 's'} could not be saved.`, action: { label: 'Retry all', run: () => { void retryAllFailed() } } })
  if (notCached) banners.push({ id: 'notCached', level: 'warn', text: "You're offline and this plan isn't saved on this device. Open it once online, or use \"Make available offline\" on the project page." })
  else if (!sync.online) banners.push({ id: 'offline', level: 'warn', text: 'You are offline. Showing data saved on this device.' })
  if (viewingOld) banners.push({ id: 'viewingOld', level: 'info', text: `Viewing ${revDetail && revDetail.id === revParam ? revisionName(revDetail) : 'earlier revision'} — read only`, action: { label: 'Back to current', run: backToCurrent } })
  if (pageBusy) banners.push({ id: 'busy', level: 'info', text: pageBusy })
  if (orphaned.count > 0) banners.push({ id: 'orphaned', level: 'warn', text: `${orphaned.count} markup${orphaned.count === 1 ? ' is' : 's are'} on page${orphaned.pages.length === 1 ? '' : 's'} ${orphaned.pages.join(', ')}, which Rev ${meta?.revisions[0]?.revision ?? ''} of this plan no longer has. They are kept in the Markups list.` })

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
      {focus ? <button className="focus-exit" title={`Exit focus mode (${hotkeys['view.focus'] || 'Esc'})`} aria-label="Exit focus mode" onClick={() => setFocus(false)}><Icon name="maximize" size={18} /></button> : <StatusChip banners={banners} />}
      {(activeTool === 'device' || (!hasSelection && drawStyleTool)) && (
        <div className="chip-stack">
          {activeTool === 'device' && (
            <FloatingChip label="Device to place" title="Device type and product to place"
              summary={<>
                <span className="set-icon" style={{ background: activeSet?.color }}>{activeSet?.icon && <img src={activeSet.icon} alt="" />}</span>
                <span className="ellipsis">{activeTypeId ? catalog.types.get(activeTypeId)?.name : activeSet?.name ?? 'Device'}</span>
              </>}>
              <div className="device-sets">
                {symbolSetList.length === 0 && <span className="muted small">No symbol sets yet. An admin can add them under Symbols.</span>}
                {symbolSetList.map(set => (
                  <button key={set.id} className={'palette-item' + (set.id === activeSetId ? ' on' : '')}
                    title={set.name} onClick={() => {
                      const first = catalog.typesBySet.get(set.id)?.[0]
                      setActiveSetId(set.id)
                      setActiveTypeId(first?.id ?? null)
                      setActiveProductId(first ? defaultProductId(catalog, first.id) : null)
                    }}>
                    <span className="set-icon" style={{ background: set.color }}>{set.icon && <img src={set.icon} alt="" />}</span>
                    <span>{set.name}</span>
                  </button>
                ))}
              </div>
              {(catalog.typesBySet.get(activeSetId ?? '') ?? []).length > 0 && (
                <select className="palette-select" aria-label="Device type" value={activeTypeId ?? ''}
                  onChange={e => { const id = e.target.value || null; setActiveTypeId(id); setActiveProductId(id ? defaultProductId(catalog, id) : null) }}>
                  <option value="">Any type</option>
                  {(catalog.typesBySet.get(activeSetId ?? '') ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {activeTypeId && productsFor(catalog, activeTypeId).length > 0 && (
                <select className="palette-select" aria-label="Product" value={activeProductId ?? ''}
                  onChange={e => setActiveProductId(e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {productsFor(catalog, activeTypeId).map(p => <option key={p.id} value={p.id}>{productOptionLabel(p)}</option>)}
                </select>
              )}
              <button className={'palette-item cone-toggle' + (showCones ? ' on' : '')} aria-pressed={showCones}
                title={showCones ? 'Hide coverage' : 'Show coverage'} onClick={() => setShowCones(!showCones)}>
                <span className="cone-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" fillOpacity={showCones ? 0.3 : 0} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 20L4 6a12 12 0 0116 0z" /></svg>
                </span>
                <span>Coverage</span>
              </button>
            </FloatingChip>
          )}
          {!hasSelection && drawStyleTool && (
            <FloatingChip label="Markup style" title="Color, line width, fill and opacity for new markups"
              summary={<><span className="style-swatch" style={{ background: defaultStyle.stroke }} /><span>{defaultStyle.strokeWidth}px</span></>}>
              <QuickStyle style={defaultStyle} onChange={setDefaultStyle} />
            </FloatingChip>
          )}
        </div>
      )}
      {!readOnly && activeTool === 'select' && (selectedIds.length > 0 || clipCount > 0) && (
        <SelectionBar count={selected.length} canPaste={clipCount > 0} multi={multiSelect} onMulti={setMultiSelect} anchor={selAnchor}
          onCopy={copySelected} onPaste={() => paste()} onDelete={deleteSelected}
          copyHint={hotkeys['edit.copy'] || undefined} deleteHint={hotkeys['edit.delete'] || undefined}
          onReplace={selectedDevices.length && selectedDevices.length === selected.length ? () => setReplacing(true) : undefined}
          onStatus={selectedDevices.length && selectedDevices.length === selected.length ? setStatusOnSelected : undefined}
          status={selectedDevices.every(m => m.status === selectedDevices[0].status) ? selectedDevices[0]?.status : undefined}
          onMore={(x, y) => { const b = selAnchor(); const m = selected[0]; if (m) setCtx({ x, y, hitId: m.id, point: b ? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } : { x: 0, y: 0 } }) }} />
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
      {pickingWindow && pageSize && <WindowPicker page={pageNum} pageSize={pageSize} view={view} onDone={finishWindowPick} />}
      {!isPhone && (
        <NavBar pageNum={pageNum} pageCount={pageCount} onGo={goTo} zoom={zoom} onZoomBy={zoomBy} onFit={fit} tool={activeTool} onTool={chooseTool} hotkeys={hotkeys} deviceScale={deviceScale} onDeviceScale={changeDeviceScale} deviceScaleReadOnly={readOnly} boxSelect={boxMode && activeTool === 'select'} onBoxSelect={readOnly ? undefined : () => { setBoxMode(b => !(b && activeTool === 'select')); setTool('select') }} fitHint={hotkeys['view.fit'] || undefined} prevHint={hotkeys['view.prevPage'] || undefined} nextHint={hotkeys['view.nextPage'] || undefined} snapHint={hotkeys['snap.toggle'] || undefined}
          scaleLabel={pageScale?.label ?? null}
          scalePanel={<ScaleControl scale={pageScale} readOnly={readOnly} busy={scaleBusy} error={scaleError}
            onPreset={s => { saveScale(s, false).catch(() => {}) }} onApplyAll={() => { if (pageScale) saveScale(pageScale, true).catch(() => {}) }}
            onClear={clearScale} onCalibrate={() => chooseTool('calibrate')} />} />
      )}
      {page && viewportSize.width > 0 && (
        <MarkupCanvas ref={markupRef} width={viewportSize.width} height={viewportSize.height}
          zoom={settledZoom} markups={canvasMarkups} areaPaths={areaPaths} lockedIds={lockedIds} tool={activeTool} symbolSets={symbolSets} catalog={catalog}
          readOnly={readOnly} selectedIds={selectedIds} onSelect={setSelectedIds} commit={canvasCommit} deviceScale={deviceScale}
          peers={peersHere} onMarquee={onMarquee} onCursor={canHover ? onCursor : undefined}
          onContextMenu={info => setCtx({ x: info.clientX, y: info.clientY, hitId: info.hitId, point: info.point })}
          onDeviceOverlap={readOnly ? undefined : onDeviceOverlap} constrain={!!shapeLock} onBoxSelected={() => { setTool('select'); setShapeLock(null) }}
          consumedRef={consumedRef} boxSelect={boxMode && activeTool === 'select'} multiSelect={multiSelect && !readOnly} showCones={showCones} legendRows={legendRowsById} stacks={stackIndex} scale={pageScale?.pointsPerFoot ?? null} pdfLines={snapLines} cableDefaults={cableDefaults} calLine={calLine}
          onCalibrate={(a, b) => { setCalLine([a, b]); setTool('select') }}
          newBase={{ document_id: documentId, page: pageNum, layer_id: activeLayerId, style: defaultStyle, stampText, symbolSetId: activeSetId,
            deviceTypeId: activeTypeId, productId: activeProductId, deviceFields: productFields(activeProductId ? catalog.products.get(activeProductId) : undefined) }}
          onCreated={m => {
            if (m.type === 'legend') { openPanel('props'); setTool('select'); setSelectedIds([m.id]); return }
            if (m.type === 'area') { setTool('select'); setNaming({ id: m.id, sheet: false, initial: '' }); return }
            if (m.type === 'text') { openPanel('props'); setTool('select'); setTimeout(() => textRef.current?.select(), 50) }
            if (m.type === 'device' && getPrefs().general.afterPlace === 'select') setTool('select')
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

  const areasProps = {
    pageAreas, parentOf: (id: string) => areaIndex.parents.get(id) ?? null,
    pathOf: (m: Markup) => areaPathIn(areaIndex, m), deviceCount: (id: string) => counts.get(id) ?? 0,
    parentChoices: (a: Markup) => parentChoices(areaIndex, a), show: showAreas, onShow: setShowAreas,
    onSelectArea: selectArea, onSelectAreas: setSelectedIds, onDraw: drawArea, onNameSheet: nameSheet,
  }

  const sidePanelEl = (
    <SidePanel tab={panelTab} onTab={setPanelTab} selected={selected} readOnly={readOnly} fieldsOnly={fieldsOnly} defaultStyle={defaultStyle} onDefaultStyle={setDefaultStyle}
      stampText={stampText} onStampText={setStampText} onUpdate={updateSelected} onDelete={deleteSelected}
      layers={layers} activeLayerId={activeLayerId} onActiveLayer={setActiveLayerId}
      hidden={hidden} locked={locked} onToggleHidden={toggleHidden} onToggleLocked={toggleLocked}
      display={{ showCones, onShowCones: setShowCones, ...deviceDisplay }}
      onReplace={selectedDevices.length && selectedDevices.length === selected.length ? () => setReplacing(true) : undefined}
      stacks={stackIndex} onSelectIds={setSelectedIds} onAddToStack={addToStack} onPullOut={pullOut} onDeleteStack={deleteStack} cableDefaults={cableDefaults}
      onAddLayer={addLayer} textRef={textRef} symbolSets={symbolSets}
      pinned={prefs.propsPinned} onPinned={v => setPref('propsPinned', v)}
      areas={areasProps}
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
      pageNum={pageNum} markups={allMarkups} commit={store.commit} symbolSets={symbolSets} localScales={scales}
      selectedIds={selectedIds} onSelectIds={setSelectedIds} readOnly={readOnly} canImport={!readOnly && !!project} isPhone={isPhone} docked={docked}
      visibleColumns={prefs.listColumns} onVisibleColumns={ids => setPref('listColumns', ids)} cableDefaults={cableDefaults}
      onJump={jumpTo} onClose={() => (docked ? setPanel('markups', false) : setShowList(false))} />
  )

  const compareEl = (
    <ComparePanel documentId={documentId} revisions={revList} canEdit={pageToolsOn} currentPage={pageNum}
      onJump={(p, x, y) => { if (isPhone) setShowCompare(false); jumpToSpot(p, x, y) }} onOpen={r => { setCompareMode(r.mode); setCompareReq(r) }} onClouds={makeClouds} />
  )

  const panelNodes: Record<PanelId, ReactNode> = {
    tools: <ToolChest entries={toolEntries} activeId={activeEntryId(tool, shapeLock, activeTypeId)} favorites={prefs.favorites} recent={prefs.recent}
      hotkeys={hotkeys} readOnly={readOnly} chest={prefs.chest} onChest={c => setPref('chest', c)} onPick={pickEntry} onFavorites={ids => setPref('favorites', ids)}
      onToggleFavorite={id => setPref('favorites', toggleFavorite(getPrefs().favorites, id))}
      onEditType={isAdmin && !readOnly ? e => { if (e.typeId) setEditTypeId(e.typeId) } : undefined}
      onAddType={isAdmin && !readOnly ? setNewTypeSetId : undefined}
      onAssignHotkey={setHkEntry} onRemoveHotkey={e => setPref('hotkeys', assignCombo(getPrefs().hotkeys, entryCommand(e), ''))} />,
    pages: pdf ? <Thumbnails pdf={pdf} current={pageNum} onSelect={goTo} canEdit={pageToolsOn} onAction={onPageAction} /> : <div className="muted small dock-empty">Loading…</div>,
    props: sidePanelEl,
    markups: markupsListEl(true),
    compare: compareEl,
    areas: <Areas areas={areasProps} readOnly={readOnly} selected={selected} onDelete={deleteSelected} />,
    layers: <Layers layers={layers} activeLayerId={activeLayerId} onActiveLayer={setActiveLayerId} hidden={hidden} locked={locked}
      onToggleHidden={toggleHidden} onToggleLocked={toggleLocked} onAddLayer={addLayer} readOnly={readOnly} symbolSets={symbolSets}
      display={{ showCones, onShowCones: setShowCones, ...deviceDisplay }} />,
  }

  const zone = (d: Dock) => {
    const ids = panelsIn(shownLayout, d)
    if (!ids.length || focus) return null
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
        ...(selectedDevices.length ? [{ label: 'Replace with…', disabled: readOnly, onClick: () => setReplacing(true) }] : []),
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
    <RoleContext.Provider value={role ?? null}>
    <CatalogContext.Provider value={catalog}>
    <div className={'viewer' + (focus ? ' focus' : '')}>
      {!focus && (
      <header className="topbar toolbar">
        <Link to={'/projects/' + projectId} className="icon-btn" title="Back to plans" aria-label="Back to plans"><Icon name="arrow-left" size={20} /></Link>
        <PlanSwitcher projectId={projectId} documentId={documentId} name={meta?.name ?? '…'}
          onPick={id => navigate(`/projects/${projectId}/documents/${id}`)} />
        <SyncIndicator compact={isPhone} />
        <span className="spacer" />
        {isPhone && (
          <button type="button" className="page-pill" aria-haspopup="dialog" aria-expanded={showThumbs} aria-label={`Page ${pageNum} of ${pageCount || '?'}, open page list`}
            onClick={() => setShowThumbs(v => !v)}>{pageNum}/{pageCount || '…'} <Icon name="chevron-down" size={12} /></button>
        )}
        <Avatars peers={peers} max={isPhone ? 1 : 4} onJump={jumpToPeer} />
        {!readOnly && !isPhone && (
          <>
            <button className="icon-btn" onClick={() => { store.undo(); setSelectedIds([]) }} disabled={!store.canUndo} title={'Undo (' + hotkeys['edit.undo'] + ')'} aria-label="Undo"><Icon name="undo" size={20} /></button>
            <button className="icon-btn" onClick={() => { store.redo(); setSelectedIds([]) }} disabled={!store.canRedo} title={'Redo (' + hotkeys['edit.redo'] + ')'} aria-label="Redo"><Icon name="redo" size={20} /></button>
          </>
        )}
        {!isPhone && (
          <>
            <span className="divider" />
            <button className={'icon-btn' + (dockOpen('left') ? ' active' : '')} title={'Tool chest and pages (' + (hotkeys['panel.tools'] || 'no key') + ')'} aria-label="Left panel" aria-pressed={dockOpen('left')} onClick={() => toggleDock('left')}><Icon name="sidebar-left" size={20} /></button>
            <button className={'icon-btn' + (dockOpen('right') ? ' active' : '')} title={'Properties (' + (hotkeys['panel.props'] || 'no key') + ')'} aria-label="Right panel" aria-pressed={dockOpen('right')} onClick={() => toggleDock('right')}><Icon name="sidebar-right" size={20} /></button>
          </>
        )}
        <MoreMenu title="More: PDF, revisions, print, panels, settings">
          <PdfMenu deviceScale={deviceScale} documentId={documentId} documentName={meta?.name ?? 'plan'} markups={allMarkups} symbolSets={symbolSets}
            scales={scales} readOnly={readOnly} commit={store.commit} showOriginal={showOrig} onShowOriginal={changeShowOrig}
            projectId={projectId} layers={layers} onLayersAdded={ls => setLayers(cur => [...cur, ...ls])} onPrint={() => { setPrintSelected([]); setPrintError(''); setPrintDraft(null); setPrintOpen(true) }} printHint={hotkeys['file.print'] || undefined} />
          <MenuSep />
          <RevisionMenu revisions={revList} viewingId={viewingOld ? revParam : null} canEdit={canEditRole && !viewingOld}
            onIssue={() => setIssueOpen(true)} onCompare={() => setPanel('compare', true)} onView={viewRevision} onMakeCurrent={makeCurrent} />
          {isPhone && (
            <>
              <MenuSep />
              <MenuHeading>Navigate</MenuHeading>
              <div className="vmenu-row" role="presentation">
                <button type="button" className="icon-btn" onClick={() => goTo(pageNum - 1)} disabled={pageNum <= 1} aria-label="Previous page"><Icon name="chevron-left" size={18} /></button>
                <span className="muted small">{pageNum} / {pageCount || '…'}</span>
                <button type="button" className="icon-btn" onClick={() => goTo(pageNum + 1)} disabled={pageNum >= pageCount} aria-label="Next page"><Icon name="chevron-right" size={18} /></button>
                <span className="spacer" />
                <button type="button" className="icon-btn" onClick={() => zoomBy(0.8)} aria-label="Zoom out"><Icon name="minus" size={18} /></button>
                <span className="muted small">{Math.round(zoom * 100)}%</span>
                <button type="button" className="icon-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in"><Icon name="plus" size={18} /></button>
                <button type="button" className="icon-btn" onClick={fit} aria-label="Fit page"><Icon name="maximize" size={18} /></button>
              </div>
              <MenuHeading>Scale</MenuHeading>
              <div className="vmenu-embed"><ScaleControl scale={pageScale} readOnly={readOnly} busy={scaleBusy} error={scaleError}
                onPreset={s => { saveScale(s, false).catch(() => {}) }} onApplyAll={() => { if (pageScale) saveScale(pageScale, true).catch(() => {}) }}
                onClear={clearScale} onCalibrate={() => chooseTool('calibrate')} /></div>
              <MenuHeading>Device size</MenuHeading>
              <div className="vmenu-embed"><DeviceSizeControl value={deviceScale} readOnly={readOnly} onChange={changeDeviceScale} /></div>
              <MenuHeading>Snapping</MenuHeading>
              <div className="vmenu-embed"><SnapControls hasScale={!!pageScale} hint={hotkeys['snap.toggle'] || undefined} /></div>
            </>
          )}
          <MenuSep />
          <MenuHeading>Panels</MenuHeading>
          {isPhone && <MenuItemBtn icon="pages" label="Pages" checked={panelOpen('pages')} onClick={() => togglePanel('pages')} />}
          {isPhone && <MenuItemBtn icon="sidebar-right" label="Properties" checked={panelOpen('props')} onClick={() => togglePanel('props')} />}
          <MenuItemBtn icon="list" label="Markups list" hint={hotkeys['panel.markups'] || undefined} checked={panelOpen('markups')} onClick={() => togglePanel('markups')} />
          <MenuItemBtn icon="map" label="Areas" hint={hotkeys['panel.areas'] || undefined} checked={panelOpen('areas')} onClick={() => togglePanel('areas')} />
          <MenuItemBtn icon="compare" label="Compare" hint={hotkeys['panel.compare'] || undefined} checked={panelOpen('compare')} onClick={() => togglePanel('compare')} />
          <MenuItemBtn icon="layers" label="Layers" hint={hotkeys['panel.layers'] || undefined} checked={panelOpen('layers')} onClick={() => togglePanel('layers')} />
          {!isPhone && <MenuItemBtn icon="maximize" label="Focus mode" hint={hotkeys['view.focus'] || undefined} onClick={() => setFocus(true)} />}
          <MenuSep />
          <MenuItemBtn icon="keyboard" label="Hotkeys…" onClick={() => setShowHotkeys(true)} />
          <Link to={`/projects/${projectId}/devices`} role="menuitem" className="vmenu-item"><span className="vmenu-ico"><Icon name="list" size={16} /></span><span className="vmenu-label">Devices (whole project)</span></Link>
          <Link to="/preferences" role="menuitem" className="vmenu-item"><span className="vmenu-ico"><Icon name="settings" size={16} /></span><span className="vmenu-label">Preferences</span></Link>
          <Link to="/settings" role="menuitem" className="vmenu-item"><span className="vmenu-ico"><Icon name="settings" size={16} /></span><span className="vmenu-label">Settings</span></Link>
        </MoreMenu>
      </header>
      )}
      {isPhone ? (
        <>
          <div className="viewer-body">
            {showThumbs && pdf && !focus && (
              <>
                <div className="scrim" onClick={() => setShowThumbs(false)} />
                <Thumbnails pdf={pdf} current={pageNum} canEdit={pageToolsOn} onAction={a => { setShowThumbs(false); onPageAction(a) }}
                  onSelect={n => { goTo(n); if (window.innerWidth < 1025) setShowThumbs(false) }} />
              </>
            )}
            {!focus && <ToolRail hotkeys={hotkeys} tool={activeTool} onTool={chooseTool} readOnly={readOnly} boxSelect={boxMode} onBoxSelect={() => { setBoxMode(b => !b); setTool('select') }}
              onUndo={() => { store.undo(); setSelectedIds([]) }} onRedo={() => { store.redo(); setSelectedIds([]) }} canUndo={store.canUndo} canRedo={store.canRedo} />}
            {viewportEl}
            {dialogs}
            {showPanel && !focus && sidePanelEl}
          </div>
          {toast && <div className="live-toast" role="status">{toast}</div>}
          {showList && markupsListEl(false)}
          {showCompare && (
            <div className="compare-view" role="dialog" aria-label="Compare revisions">
              <header className="topbar toolbar"><strong>Compare</strong><span className="spacer" /><button className="primary" onClick={() => setShowCompare(false)}>Close</button></header>
              <div className="compare-body">{compareEl}</div>
            </div>
          )}
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
      <input ref={pickFile} type="file" accept="application/pdf,.pdf" hidden
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; const then = pendingPick.current; pendingPick.current = null; if (f && then) then(f) }} />
      {issueOpen && (
        <IssueRevisionDialog documentId={documentId} documentName={meta?.name ?? 'this plan'} nextRevision={(revList[0]?.revision ?? 0) + 1}
          onClose={() => setIssueOpen(false)}
          onIssued={rev => { setIssueOpen(false); refreshRevs(); setToast(`Issued ${revisionName(rev)}`) }} />
      )}
      {printOpen && !pickingWindow && (
        <PrintDialog key={printDraft ? 'draft' : 'fresh'} initial={printDraft ?? undefined}
          onPickWindow={o => { setPrintDraft({ ...o, hiddenLayers: o.hiddenLayers }); setPickingWindow(true) }} pageCount={pageCount} currentPage={pageNum} selectedPages={printSelected} layers={layers} symbolSets={symbolSetList} hidden={hidden}
          busy={printBusy} error={printError} onPrint={doPrint} onSavePdf={savePrintPdf} onClose={closePrint} />
      )}
      {compareReq && (
        <CompareView documentId={documentId} a={compareReq.a} b={compareReq.b} mode={compareMode} onMode={setCompareMode}
          symbolSets={symbolSets} initialPage={compareReq.page} focus={compareReq.focus} onClose={() => setCompareReq(null)} />
      )}
      {replacing && selectedDevices.length > 0 && (
        <ReplaceDialog devices={selectedDevices} symbolSets={symbolSetList} onApply={replaceSelected} onClose={() => setReplacing(false)} />
      )}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx)} onClose={closeCtx} />}
      {showHotkeys && <HotkeyDialog overrides={prefs.hotkeys} onChange={o => setPref('hotkeys', o)} onClose={() => setShowHotkeys(false)}
        replaceChoice={prefs.replaceOnOverlap} onReplaceChoice={c => setPref('replaceOnOverlap', c)} />}
      {hkEntry && <HotkeyRecorder commandId={entryCommand(hkEntry)} label={hkEntry.label} overrides={prefs.hotkeys} onChange={o => setPref('hotkeys', o)} onClose={() => setHkEntry(null)}
        nameOf={id => { const eid = entryIdOfCommand(id); return (eid && entryMap.get(eid)?.label) || commandLabelOf(id) }} />}
      {editTypeId && catalog.types.get(editTypeId) && (() => {
        const t = catalog.types.get(editTypeId)!
        return (
          <DeviceTypeEditor key={t.id} initial={draftOfType(t)} set={symbolSets.get(t.symbol_set_id)}
            onClose={() => setEditTypeId(null)}
            onSaved={async () => { await reloadCatalog(); setEditTypeId(null) }}
            onRemoved={async () => { await reloadCatalog(); setEditTypeId(null) }} />
        )
      })()}
      {newTypeSetId && (
        <DeviceTypeEditor key={`new:${newTypeSetId}`} initial={{ setId: newTypeSetId, name: '', tag_prefix: '', icon: '', fields: [], default_product_id: null, coverage: { on: false, angle: 90, range_ft: 20 } }}
          set={symbolSets.get(newTypeSetId)} onClose={() => setNewTypeSetId(null)}
          onSaved={async () => { await reloadCatalog(); setNewTypeSetId(null) }}
          onRemoved={async () => { setNewTypeSetId(null) }} />
      )}
      {overlap && <OverlapPrompt message={overlap.message} onChoose={answerOverlap} />}
    </div>
    </CatalogContext.Provider>
    </RoleContext.Provider>
  )
}
