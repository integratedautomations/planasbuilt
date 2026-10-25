import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Circle, Group, Label, Layer, Line, Rect, Shape, Stage, Tag, Text, Transformer } from 'react-konva'
import Konva from 'konva'
import { bakeBox, bakePath, boxFromDrag, pathFromPoints, hasDrawableGeometry, simplify, snap45 } from './geometry'
import type { Pt } from './geometry'
import { MarkupShape } from './MarkupShape'
import type { Change } from './useMarkups'
import { isSheetArea } from './areas'
import { deviceRadius, findSnapTarget, stackTop, tagRange } from './stacks'
import type { StackIndex } from './stacks'
import { findOverlapTarget } from './placeReplace'
import { deviceCenter } from './geometry'
import { markupBounds, markupsInBox, rectFromCorners, rectsIntersect } from './selection'
import { copyMarkup } from './copy'
import type { Rect as Box } from './selection'
import { AREA_STYLE, isBoxType } from './types'
import { deviceIcon, typeMountOf } from '../catalog/catalog'
import { DEFAULT_LEGEND, legendFields } from './legend'
import type { LegendRow } from './legend'
import type { Catalog } from '../catalog/catalog'
import type { BoxGeometry, Fov, Markup, MarkupStyle, MarkupType, PathGeometry, SymbolSet, Tool } from './types'
import { uuid } from '../uuid'
import { initialCoverage } from './coverage'
import { PLACE_ROTATE_SLOP_PX, angleLabel, faceAngle, faceCoverageOnly, createHoldGate, mouseHoldMs, placeAngle, rotatesCoverage, touchHoldMs } from './placeRotate'
import type { HoldGate } from './placeRotate'
import type { Peer } from '../realtime/presence'
import { REDLINE } from './canvasFonts'
import { createTouchArbiter, isDoubleTap } from '../viewer/touchGesture'
import { usePrefs } from '../prefs/store'
import { haptic } from '../prefs/general'
import { buildMarkupIndex, handlePoints, snapActive, snapHandles, snapPoint } from './snap'
import type { SegIndex, SnapEnv, SnapHit, SnapKind, SnapOpts } from './snap'
import { GRID_DRAW_MIN_PX, SNAP_RADIUS_PX, gridStep as gridStepOf } from './snapConfig'
import { ALIGN_BOX_TYPES, alignBox, alignDevice, alignable, boxFromDragAligned, withCenter } from './align'
import { DEFAULT_CABLE_SETTINGS, cableColor, cableLength, danglingEnds, deviceCentreOf, nearestDevice, relinkEnds } from './cables'
import type { CableSettings } from './cables'
import { formatFeetInches } from './measure'

// Only the left button drags markups: middle pans the plan and right box-selects.
Konva.dragButtons = [0]

/** A plain right-click: where it happened and which markup (if any) is under it. */
export interface ContextInfo { clientX: number; clientY: number; hitId: string | null; point: Pt }

export interface MarkupCanvasHandle {
  stage: () => Konva.Stage | null
  cancelDraft: () => void
  /** A second finger arrived / a touch was lost: drop the in-flight tap or drag, keep points already placed. */
  cancelGesture: () => void
  finishDraft: () => void
  /** A device is held down after placing (rotate-on-hold in progress): the viewport must not pan. */
  isPlacing: () => boolean
}

interface Props {
  width: number
  height: number
  zoom: number
  markups: Markup[]
  /** Markups on a locked layer or symbol set: visible but not selectable. */
  lockedIds: Set<string>
  tool: Tool
  readOnly: boolean
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  commit: (change: Change) => void
  /** Template for new markups: document, page, layer and current style. */
  newBase: { document_id: string; page: number; layer_id: string | null; style: MarkupStyle; stampText: string; symbolSetId: string | null
    /** Device type and product being placed, and the field values the product prefills. */
    deviceTypeId?: string | null; productId?: string | null; deviceFields?: Record<string, string | number | boolean> }
  symbolSets: Map<string, SymbolSet>
  catalog: Catalog
  /** Set true when the markup layer owns the current pointer (so the viewport doesn't pan). */
  consumedRef: React.MutableRefObject<boolean>
  onCreated?: (m: Markup) => void
  /** points_per_foot of the current page, or null when not calibrated. */
  scale: number | null
  /** Called with the two page-space endpoints of a finished calibration line. */
  onCalibrate: (a: Pt, b: Pt) => void
  /** Temporary calibration line to keep showing while the length prompt is open. */
  calLine: [Pt, Pt] | null
  /** Area id to names from the outermost area down (for area labels). */
  areaPaths: Map<string, string[]>
  /** One-finger/mouse drag on empty space draws a selection box instead of panning. */
  boxSelect: boolean
  /** Taps toggle markups in and out of the selection (touch multi-select). */
  multiSelect: boolean
  /** Global coverage cone switch. */
  showCones: boolean
  /** Device size multiplier: new devices and the cursor ghost are drawn at 24 x this. */
  deviceScale?: number
  /** Live rows of each legend on this page (by markup id). */
  legendRows?: Map<string, LegendRow[]>
  /** Device stacks on this page (same-set devices on one spot). */
  stacks: StackIndex
  /** Other people on this page (cursor + selection are drawn in their colour). */
  peers?: Peer[]
  /** Pointer position in page coordinates, or null when it left the canvas. Omitted when cursors are not broadcast. */
  onCursor?: (p: Pt | null) => void
  /** Box-select drag rectangle (page coordinates) while dragging; null when it ends. Lets others see what is being pointed at. */
  onMarquee?: (r: { x: number; y: number; w: number; h: number } | null) => void
  /** Right-click without dragging. */
  onContextMenu?: (info: ContextInfo) => void
  /** Drawn rectangles/ellipses are forced to squares/circles (Square and Circle tools). */
  constrain?: boolean
  /** A right-drag box picked markups while a drawing tool was active: the viewer switches to the Select tool so they show as selected. */
  onBoxSelected?: () => void
  /**
   * A new device is being placed on a device of another type. Return true when the viewer takes over (asks, or replaces);
   * false to place the new device normally. Omit to always place.
   */
  onDeviceOverlap?: (target: Markup, placed: Markup) => boolean
  /** Vector lines of the PDF page, indexed for snapping (null while loading / switched off / scanned pages). */
  pdfLines?: SegIndex | null
  /** Project cable defaults (slack %, drop ft) for the length shown on a cable. */
  cableDefaults?: CableSettings
}

const TWO_POINT: MarkupType[] = ['line', 'arrow', 'measure-length', 'measure-radius']
const CLICK_PATHS: MarkupType[] = ['polyline', 'polygon', 'cable', 'measure-polylength', 'measure-area', 'area']
const CLOSED: MarkupType[] = ['polygon', 'measure-area', 'area']
const rectPoints = (a: Pt, b: Pt): Pt[] => [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
const DRAG_TOOLS: MarkupType[] = ['line', 'arrow', 'measure-length', 'measure-radius', 'rect', 'ellipse', 'cloud', 'highlight', 'text', 'freehand']

const CAL_STYLE: MarkupStyle = { stroke: '#1971c2', fill: '', strokeWidth: 2, opacity: 1, fontSize: 18, dash: true }

export const MarkupCanvas = forwardRef<MarkupCanvasHandle, Props>(function MarkupCanvas(props, ref) {
  const { width, height, zoom, markups, lockedIds, tool, readOnly, selectedIds, onSelect, commit, newBase, symbolSets, catalog, consumedRef, onCreated, scale, onCalibrate, calLine, areaPaths, boxSelect, multiSelect, showCones, legendRows, stacks, peers, onCursor, onMarquee, onContextMenu, constrain, onBoxSelected, onDeviceOverlap, pdfLines, cableDefaults } = props
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const [draft, setDraft] = useState<Markup | null>(null)
  const dragStart = useRef<Pt | null>(null)
  const freehandPts = useRef<Pt[]>([])
  const clickPts = useRef<Pt[]>([])
  const [pointOverride, setPointOverride] = useState<{ id: string; points: number[] } | null>(null)
  const countGroup = useRef<{ id: string; n: number } | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const marqueeStart = useRef<{ p: Pt; add: boolean; right?: { cx: number; cy: number; hitId: string | null; moved: boolean } } | null>(null)
  const marqueeRect = useRef<Box | null>(null)
  useEffect(() => {
    onMarquee?.(marquee && (marquee.width > 2 || marquee.height > 2) ? { x: marquee.x, y: marquee.y, w: marquee.width, h: marquee.height } : null)
  }, [marquee]) // eslint-disable-line react-hooks/exhaustive-deps
  // Peers' box-selects stay on screen ~3s after release, fading over the last second.
  const [held, setHeld] = useState<Record<string, { r: { x: number; y: number; w: number; h: number }; color: string; name: string; ended: number | null }>>({})
  const [nowTick, setNowTick] = useState(0)
  useEffect(() => {
    setHeld(h => {
      let next = h, changed = false
      const ids = new Set<string>()
      for (const p of peers ?? []) {
        ids.add(p.clientId)
        if (p.marquee) { next = { ...next, [p.clientId]: { r: p.marquee, color: p.color, name: p.name, ended: null } }; changed = true }
        else if (next[p.clientId] && next[p.clientId].ended === null) { next = { ...next, [p.clientId]: { ...next[p.clientId], ended: Date.now() } }; changed = true }
      }
      for (const id of Object.keys(next)) if (!ids.has(id)) { next = { ...next }; delete next[id]; changed = true }
      return changed ? next : h
    })
  }, [peers])
  const anyEnded = Object.values(held).some(h => h.ended !== null)
  useEffect(() => {
    if (!anyEnded) return
    const t = setInterval(() => {
      setNowTick(n => n + 1)
      setHeld(h => {
        const keep = Object.entries(h).filter(([, v]) => v.ended === null || Date.now() - v.ended < 3000)
        return keep.length === Object.keys(h).length ? h : Object.fromEntries(keep)
      })
    }, 100)
    return () => clearInterval(t)
  }, [anyEnded])
  void nowTick
  /** Armed device tool: where the semi-transparent preview of the device follows the pointer (null when hidden). */
  const [devGhost, setDevGhost] = useState<Pt | null>(null)
  /** Geometry of the cursor ghost (snapped and, with Align to walls, turned to the line under it). */
  const [ghostGeo, setGhostGeo] = useState<BoxGeometry | null>(null)
  // Snapping: settings from the user's prefs, an index of this page's markups, and the PDF line index from the viewer.
  const snapSettings = usePrefs().snap
  const holdPref = usePrefs().holdRotateMs
  const general = usePrefs().general
  const markupIndex = useMemo(() => (snapSettings.on && (snapSettings.markups || snapSettings.devices) ? buildMarkupIndex(markups) : null),
    [markups, snapSettings.on, snapSettings.markups, snapSettings.devices])
  const snapEnv: SnapEnv = { settings: snapSettings, pdf: pdfLines ?? null, markups: markupIndex, gridStep: gridStepOf(snapSettings, scale) }
  /** Where the pointer snapped to (indicator), in page space. */
  const [snapMark, setSnapMark] = useState<{ x: number; y: number; kind: SnapKind } | null>(null)
  const snapped = !!snapMark
  useEffect(() => { if (snapped) haptic(general.haptics, 8) }, [snapped]) // eslint-disable-line react-hooks/exhaustive-deps
  /** A dragged device / box that turned to a line: what to commit on drop. */
  const dragAlignRef = useRef<{ id: string; geometry: BoxGeometry } | null>(null)
  /** Angle of the line a box drag started on (Align to walls): the drawn box takes this rotation. */
  const boxAlignRef = useRef<number | null>(null)
  // Touch: nothing commits on pointerdown. The arbiter decides tap / drag / pinch; window listeners follow the finger
  // (the viewport captures the pointer for panning, so the stage never sees its move/up).
  const arb = useRef(createTouchArbiter())
  const touch = useRef<{ ev: Konva.KonvaEventObject<PointerEvent> | null; pt: Pt; kind: 'draw' | 'marquee' | 'tap' | 'other'; hitId: string | null; handle: boolean; dragged: boolean; cancelled: boolean; timer: number; lastTap: { x: number; y: number; t: number } | null; unlisten: (() => void) | null }>(
    { ev: null, pt: { x: 0, y: 0 }, kind: 'other', hitId: null, handle: false, dragged: false, cancelled: false, timer: 0, lastTap: null, unlisten: null })
  const pointerOverride = useRef<Pt | null>(null)
  const tapMode = useRef(false)
  const [touchUi, setTouchUi] = useState(false)
  const latest = useRef<Record<string, (...a: never[]) => unknown>>({})
  /** Device placement held open until release: the pointer may turn it first. `base` is the geometry as placed; `m` is what commits. */
  const placeRef = useRef<{ m: Markup; base: BoxGeometry; c: Pt; cx: number; cy: number; moved: boolean; aligned: boolean; gate: HoldGate } | null>(null)
  const [placeView, setPlaceView] = useState<{ m: Markup; to: Pt | null; angle: number | null } | null>(null)
  const [snapHint, setSnapHint] = useState<{ x: number; y: number; r: number } | null>(null)
  // Plex arrives from Google Fonts after the first draw: re-measure canvas text once it has loaded.
  useEffect(() => {
    let live = true
    document.fonts?.ready.then(() => {
      const stage = stageRef.current
      if (!live || !stage) return
      stage.find('Text').forEach(t => (t as unknown as { _setTextData(): void })._setTextData())
      stage.batchDraw()
    })
    return () => { live = false }
  }, [])
  /** Ctrl+drag copy in progress: the originals stay drawn in place while the dragged node is the copy. */
  const [copyGhosts, setCopyGhosts] = useState<Markup[] | null>(null)
  const copyDrag = useRef(false)
  const [fovOverride, setFovOverride] = useState<{ id: string; fov: Fov } | null>(null)

  const byId = new Map(markups.map(m => [m.id, m]))
  const selected = selectedIds.map(id => byId.get(id)).filter((m): m is Markup => !!m)
  const single = selected.length === 1 ? selected[0] : null
  const isDrawTool = tool !== 'select' && tool !== 'pan' && !readOnly

  // Attach transformer to selected nodes (2-point lines use point handles instead)
  useEffect(() => {
    const tr = trRef.current, stage = stageRef.current
    if (!tr || !stage) return
    const nodes = readOnly || tool !== 'select' ? [] : selected
      .filter(m => !(selected.length === 1 && TWO_POINT.includes(m.type)) && !isSheetArea(m))
      .map(m => stage.findOne<Konva.Group>('#' + m.id))
      .filter((n): n is Konva.Group => !!n)
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  })

  const pointer = (): Pt => pointerOverride.current ?? stageRef.current!.getRelativePointerPosition() ?? { x: 0, y: 0 }

  const liveZoom = () => stageRef.current?.scaleX() || zoom
  const ctrlOf = (ev: unknown) => { const e = ev as { ctrlKey?: boolean; metaKey?: boolean } | null | undefined; return !!e && !!(e.ctrlKey || e.metaKey) }
  const showMark = (hit: SnapHit | null) => setSnapMark(cur => (!hit ? null
    : cur && cur.x === hit.point.x && cur.y === hit.point.y && cur.kind === hit.kind ? cur : { x: hit.point.x, y: hit.point.y, kind: hit.kind }))
  /** Best snap for a pointer position (null with snapping off or Ctrl held); moves the indicator unless `mark` is false. */
  function snapAt(p: Pt, ev: unknown, opts: SnapOpts = {}, mark = true): SnapHit | null {
    const hit = snapActive(snapEnv, ctrlOf(ev)) ? snapPoint(snapEnv, p, liveZoom(), opts) : null
    if (mark) showMark(hit)
    return hit
  }

  /**
   * Cable points snap to a device centre first (so the end can lock to it). Not with Shift or Ctrl held. Shows the snap marker when
   * `mark` is set. The device to lock is found again from the point when the cable is finished.
   */
  function cableDeviceSnap(p: Pt, ev: unknown, mark = true): SnapHit | null {
    const e = ev as { shiftKey?: boolean } | null | undefined
    if (e?.shiftKey || ctrlOf(ev)) return null
    const d = nearestDevice(markups, p, SNAP_RADIUS_PX / liveZoom())
    const c = d && deviceCentreOf(d)
    const hit: SnapHit | null = c ? { point: c, kind: 'device' } : null
    if (mark) showMark(hit)
    return hit
  }

  const newMarkup = (type: MarkupType, geometry: BoxGeometry | PathGeometry): Markup => ({
    id: uuid(), document_id: newBase.document_id, page: newBase.page, type, geometry,
    style: type === 'area' ? { ...AREA_STYLE } : { ...newBase.style }, text: type === 'stamp' ? newBase.stampText : '', layer_id: newBase.layer_id,
    ...(type === 'device' ? { symbol_set_id: newBase.symbolSetId, device_type_id: newBase.deviceTypeId ?? null, product_id: newBase.productId ?? null, tag: '', status: 'planned' as const, fields: { ...newBase.deviceFields } } : {}),
  })

  const finish = (m: Markup | null) => {
    placeRef.current = null
    boxAlignRef.current = null
    setSnapMark(null)
    setPlaceView(null)
    setDraft(null)
    dragStart.current = null
    freehandPts.current = []
    clickPts.current = []
    if (!m) return
    commit([{ before: null, after: m }])
    if (m.type === 'device') haptic(general.haptics, 15)
    onSelect([m.id])
    onCreated?.(m)
  }

  const finishClickPath = () => {
    if (!draft || !CLICK_PATHS.includes(draft.type)) return
    // Drop the rubber-band point and any double-click duplicate
    const pts = clickPts.current.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.5)
    const min = CLOSED.includes(draft.type) ? 3 : 2
    const geometry = pts.length >= min ? pathFromPoints(pts) : null
    // A cable end that sits on a device centre locks to that device
    finish(geometry ? newMarkup(draft.type, draft.type === 'cable' ? relinkEnds(geometry, byId, newBase.page) : geometry) : null)
  }

  const cancelMarquee = () => { marqueeStart.current = null; marqueeRect.current = null; setMarquee(null) }

  useImperativeHandle(ref, () => ({
    stage: () => stageRef.current,
    cancelDraft: () => { cancelMarquee(); finish(null) },
    cancelGesture: () => cancelGesture(),
    finishDraft: finishClickPath,
    isPlacing: () => !!placeRef.current,
  }))

  // Leaving a tool abandons its half-drawn markup
  useEffect(() => { cancelMarquee(); finish(null); countGroup.current = null; setSnapHint(null); setDevGhost(null); setSnapMark(null) }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps

  const markupIdOf = (node: Konva.Node | null): string | null => {
    while (node && node !== stageRef.current) {
      if (node.name() === 'markup') return node.id()
      node = node.getParent()
    }
    return null
  }

  /** The markup under a point: the one Konva hit, else the topmost non-area markup whose bounds contain it (draw tools don't hit-test). */
  function markupAt(p: Pt, hit: string | null): string | null {
    if (hit) return hit
    const probe = { x: p.x - 2 / zoom, y: p.y - 2 / zoom, width: 4 / zoom, height: 4 / zoom }
    for (let i = markups.length - 1; i >= 0; i--) {
      const m = markups[i]
      if (m.type !== 'area' && !lockedIds.has(m.id) && rectsIntersect(markupBounds(m), probe)) return m.id
    }
    return null
  }

  /** Open a held placement at `c`: nothing commits until commitPlace. */
  function beginPlace(m: Markup, c: Pt, cx: number, cy: number, aligned = false, holdMs = 0) {
    placeRef.current = { m, base: m.geometry as BoxGeometry, c, cx, cy, moved: false, aligned, gate: createHoldGate(holdMs) }
    setDevGhost(null); setSnapHint(null)
    setPlaceView({ m, to: null, angle: null })
  }

  /**
   * Where and how a new device goes for a pointer position: snapped to a line / corner / grid and, with Align to walls, turned
   * to the line it snapped to (a wall D sits with its flat side on the line, facing away from it toward the pointer).
   */
  function placement(p: Pt, set: SymbolSet, ev: unknown, mark = true): { geometry: BoxGeometry; at: Pt; c: Pt; aligned: boolean } {
    const size = 24 * (props.deviceScale ?? 1)
    const typeCov = newBase.deviceTypeId ? catalog?.types.get(newBase.deviceTypeId)?.coverage : null
    const covFov = initialCoverage(set, typeCov, scale ?? null)
    const hit = snapAt(p, ev, {}, mark)
    const at = hit?.point ?? p
    let geometry: BoxGeometry = { x: at.x - size / 2, y: at.y - size / 2, width: size, height: size, rotation: 0, ...(covFov ? { fov: covFov } : {}) }
    const aligned = !!hit && snapSettings.align && alignable(hit)
    if (hit && aligned) geometry = alignDevice(geometry, hit as typeof hit & { angle: number }, p, newBase.deviceTypeId ? catalog?.types.get(newBase.deviceTypeId)?.mount : undefined)
    return { geometry, at, c: deviceCenter(geometry), aligned }
  }

  /** Touch long-press on empty space with the device tool: place a device and let the finger turn it. False = not applicable (stack / overlap / no set). */
  function startPlace(p: Pt, cx: number, cy: number): boolean {
    const set = newBase.symbolSetId ? symbolSets.get(newBase.symbolSetId) : undefined
    if (!set || readOnly || placeRef.current) return false
    if (findSnapTarget(markups, p, set.id, 1.2, newBase.deviceTypeId ?? null)) return false
    const pl = placement(p, set, null, false)
    if (onDeviceOverlap && findOverlapTarget(markups, pl.at, set.id, newBase.deviceTypeId ?? null)) return false
    beginPlace(newMarkup('device', pl.geometry), pl.c, cx, cy, pl.aligned, 0) // the long press itself was the hold
    return true
  }

  /** Pointer moved while a placement is held: past the slop it turns the device to face the pointer (15 degree steps, free with Alt). */
  function updatePlace(ptr: Pt, free: boolean, cx: number, cy: number) {
    const pl = placeRef.current
    if (!pl) return
    if (!pl.moved) {
      if (Math.hypot(cx - pl.cx, cy - pl.cy) <= PLACE_ROTATE_SLOP_PX) return
      if (!pl.gate.ready()) return // released early = plain placement; moving before the hold time does nothing
      pl.moved = true
    }
    const angle = placeAngle(pl.c, ptr, free, general.rotateStep)
    if (angle === null) return
    // Locked to a wall or corner: only the coverage turns; the device keeps its aligned rotation
    if (pl.aligned && !rotatesCoverage(pl.base)) return
    pl.m = { ...pl.m, geometry: pl.aligned ? faceCoverageOnly(pl.base, angle) : withCenter(faceAngle(pl.base, angle), pl.c) }
    setPlaceView({ m: pl.m, to: ptr, angle })
  }

  /** Release: the device and its rotation commit as one change (one undo step). */
  function commitPlace() {
    const pl = placeRef.current
    if (pl) finish(pl.m)
  }

  function handleDown(e: Konva.KonvaEventObject<PointerEvent>) {
    if (e.evt.button === 2) {
      // Right button: box-select in any tool; released without dragging it is a context-menu click
      const p = pointer()
      marqueeStart.current = { p, add: e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey, right: { cx: e.evt.clientX, cy: e.evt.clientY, hitId: markupIdOf(e.target), moved: false } }
      marqueeRect.current = rectFromCorners(p, p)
      return
    }
    if (e.evt.button !== 0) return
    const target = e.target
    const onTransformer = target.getParent()?.getClassName?.() === 'Transformer'
    const hitId = markupIdOf(target)

    if (!isDrawTool) {
      if (tool === 'pan') { consumedRef.current = false; return }
      if (onTransformer || target.name() === 'point-handle') { consumedRef.current = true; return }
      if (hitId) {
        consumedRef.current = true
        // Tapping a stack acts on all of its members (locked ones excluded)
        const hitStack = stacks.byId.get(hitId)
        const group = hitStack ? hitStack.members.map(x => x.id).filter(i => !lockedIds.has(i)) : [hitId]
        if (e.evt.shiftKey || multiSelect) {
          onSelect(group.every(i => selectedIds.includes(i)) ? selectedIds.filter(i => !group.includes(i)) : [...selectedIds, ...group.filter(i => !selectedIds.includes(i))])
        } else if (!group.every(i => selectedIds.includes(i))) onSelect(group)
      } else if ((boxSelect || e.evt.shiftKey || (e.evt.pointerType === 'pen' && general.pencil === 'box')) && !tapMode.current) {
        consumedRef.current = true // empty space with Shift / box mode / Apple Pencil: marquee
        const p = pointer()
        marqueeStart.current = { p, add: e.evt.shiftKey || multiSelect }
        marqueeRect.current = rectFromCorners(p, p)
        setMarquee(marqueeRect.current)
      } else {
        consumedRef.current = false // empty space: pan
        if (!multiSelect) onSelect([])
      }
      return
    }

    consumedRef.current = true
    const p = pointer()
    const cal = tool === 'calibrate'
    if (tool === 'area-rect') {
      const a = snapAt(p, e.evt, {}, false)?.point ?? p
      dragStart.current = a
      setDraft(newMarkup('area', pathFromPoints(rectPoints(a, a))))
      return
    }
    const t = (cal ? 'line' : tool) as MarkupType
    if (t === 'legend') {
      finish({ ...newMarkup('legend', { x: p.x, y: p.y, width: 260, height: 120, rotation: 0 }), style: { ...newBase.style, stroke: '#343a40', fill: '#ffffff', strokeWidth: 1, fontSize: 12 }, fields: legendFields(DEFAULT_LEGEND) })
      return
    }
    if (t === 'stamp') {
      finish(newMarkup('stamp', { x: p.x - 80, y: p.y - 25, width: 160, height: 50, rotation: 0 }))
      return
    }
    if (t === 'device') {
      const set = newBase.symbolSetId ? symbolSets.get(newBase.symbolSetId) : undefined
      if (!set) return
      const covFov = initialCoverage(set, newBase.deviceTypeId ? catalog?.types.get(newBase.deviceTypeId)?.coverage : null, scale ?? null)
      // Close to a device of the same set: land exactly on it so it joins its stack
      const snap = findSnapTarget(markups, p, set.id, 1.2, newBase.deviceTypeId ?? null)
      setSnapHint(null)
      if (snap) {
        const sg = snap.geometry as BoxGeometry
        finish(newMarkup('device', {
          x: sg.x, y: sg.y, width: sg.width, height: sg.height, rotation: sg.rotation,
          ...(covFov ? { fov: covFov } : {}),
        }))
        return
      }
      const pl = placement(p, set, e.evt, false)
      const placed = newMarkup('device', pl.geometry)
      // On top of a device of another type: the viewer may replace it or ask first
      const over = onDeviceOverlap ? findOverlapTarget(markups, pl.at, set.id, newBase.deviceTypeId ?? null) : null
      if (over && onDeviceOverlap!(over, placed)) { finish(null); return }
      // Mouse / pen: keep the placement open until release so the pointer can turn it. Touch taps place at once.
      if (e.evt.pointerType === 'touch') finish(placed)
      else beginPlace(placed, pl.c, e.evt.clientX, e.evt.clientY, pl.aligned, mouseHoldMs(holdPref))
      return
    }
    if (t === 'count') {
      const grp = countGroup.current ?? (countGroup.current = { id: uuid(), n: 0 })
      grp.n++
      const m = newMarkup('count', pathFromPoints([snapAt(p, e.evt, {}, false)?.point ?? p]))
      commit([{ before: null, after: { ...m, fields: { group: grp.id, n: grp.n } } }])
      return
    }
    if (CLICK_PATHS.includes(t)) {
      const pts = clickPts.current
      const sp = (t === 'cable' ? cableDeviceSnap(p, e.evt, false)?.point : undefined) ?? (e.evt.shiftKey ? p : snapAt(p, e.evt, { extra: pts.slice(0, -1) }, false)?.point ?? p)
      if (!pts.length) {
        clickPts.current = [sp, sp]
      } else {
        const first = pts[0]
        if (CLOSED.includes(t) && pts.length >= 4 && Math.hypot(p.x - first.x, p.y - first.y) < 10 / zoom) {
          clickPts.current = pts.slice(0, -1)
          setDraft(newMarkup(t, pathFromPoints(clickPts.current)))
          finishClickPath()
          return
        }
        const last = e.evt.shiftKey ? snap45(pts[pts.length - 2], p) : sp
        clickPts.current = [...pts.slice(0, -1), last, last]
      }
      setDraft(newMarkup(t, pathFromPoints(clickPts.current)))
      return
    }
    if (DRAG_TOOLS.includes(t)) {
      const hit = t === 'freehand' || e.evt.shiftKey ? null : snapAt(p, e.evt, {}, false)
      const a = hit?.point ?? p
      boxAlignRef.current = hit && snapSettings.align && alignable(hit) && (t === 'rect' || t === 'cloud' || t === 'text') ? hit.angle : null
      dragStart.current = a
      freehandPts.current = [a]
      const base = newMarkup(t, isBoxType(t) ? boxFromDrag(a, a) : pathFromPoints([a, a]))
      setDraft(cal ? { ...base, style: CAL_STYLE } : base)
    }
  }

  function handleMove(e: Konva.KonvaEventObject<PointerEvent>) {
    if (onCursor) onCursor(stageRef.current?.getRelativePointerPosition() ?? null)
    if (placeRef.current) { updatePlace(pointer(), e.evt.altKey, e.evt.clientX, e.evt.clientY); return }
    if (e.evt.pointerType === 'touch') { setDevGhost(null); setSnapHint(null) }
    else if (tool === 'device' && !readOnly && newBase.symbolSetId && symbolSets.get(newBase.symbolSetId)) {
      if (e.evt.buttons & 4) setDevGhost(null)
      else { const pl = placement(pointer(), symbolSets.get(newBase.symbolSetId)!, e.evt); setDevGhost(pl.c); setGhostGeo(pl.geometry) }
    } else if (devGhost) setDevGhost(null)
    if (marqueeStart.current) {
      const r = marqueeStart.current.right
      if (r && !r.moved) {
        if (Math.hypot(e.evt.clientX - r.cx, e.evt.clientY - r.cy) < 4) return
        r.moved = true
      }
      marqueeRect.current = rectFromCorners(marqueeStart.current.p, pointer())
      setMarquee(marqueeRect.current)
      return
    }
    if (tool === 'device' && !draft && !readOnly && e.evt.pointerType !== 'touch') {
      const t = findSnapTarget(markups, pointer(), newBase.symbolSetId, 1.2, newBase.deviceTypeId ?? null)
      if (t) {
        const c = deviceCenter(t.geometry as BoxGeometry)
        setSnapHint(h => (h && h.x === c.x && h.y === c.y ? h : { ...c, r: deviceRadius(t.geometry as BoxGeometry) }))
      } else setSnapHint(h => (h ? null : h))
      return
    }
    if (!draft) {
      // Hovering with a drawing tool: show where the first point would snap
      if (isDrawTool && e.evt.pointerType !== 'touch' && !['freehand', 'stamp', 'legend', 'device'].includes(tool)) {
        if (!(tool === 'cable' && cableDeviceSnap(pointer(), e.evt))) snapAt(pointer(), e.evt)
      }
      return
    }
    const raw = pointer()
    const shift = e.evt.shiftKey
    const clickPath = CLICK_PATHS.includes(draft.type) && !dragStart.current
    const hit = (draft.type === 'cable' ? cableDeviceSnap(raw, e.evt) : null)
      ?? (shift || draft.type === 'freehand' ? null : snapAt(raw, e.evt, clickPath ? { extra: clickPts.current.slice(0, -1) } : {}))
    if (!hit) showMark(null)
    const p = hit?.point ?? raw
    if (clickPath) {
      const pts = clickPts.current
      const last = shift && pts.length > 1 ? snap45(pts[pts.length - 2], p) : p
      clickPts.current = [...pts.slice(0, -1), last]
      setDraft({ ...draft, geometry: pathFromPoints(clickPts.current) })
      return
    }
    const a = dragStart.current
    if (!a) return
    if (draft.type === 'area') {
      setDraft({ ...draft, geometry: pathFromPoints(rectPoints(a, p)) })
      return
    }
    if (draft.type === 'freehand') {
      freehandPts.current.push(p)
      setDraft({ ...draft, geometry: pathFromPoints(freehandPts.current) })
    } else if (isBoxType(draft.type)) {
      setDraft({ ...draft, geometry: boxAlignRef.current !== null ? boxFromDragAligned(a, p, boxAlignRef.current, shift || !!constrain) : boxFromDrag(a, p, shift || !!constrain) })
    } else {
      setDraft({ ...draft, geometry: pathFromPoints([a, shift ? snap45(a, p) : p]) })
    }
  }

  function handleUp(e: Konva.KonvaEventObject<PointerEvent>) {
    const ms = marqueeStart.current, box = marqueeRect.current
    if (ms?.right) {
      if (e.evt.button !== 2) return
      cancelMarquee()
      if (!ms.right.moved) {
        const hitId = markupAt(ms.p, ms.right.hitId)
        if (hitId && !selectedIds.includes(hitId)) {
          const stk = stacks.byId.get(hitId)
          onSelect(stk ? stk.members.map(x => x.id).filter(i => !lockedIds.has(i)) : [hitId])
        }
        onContextMenu?.({ clientX: ms.right.cx, clientY: ms.right.cy, hitId, point: ms.p })
        return
      }
      const ids = box ? markupsInBox(markups, box, lockedIds) : []
      onSelect(ms.add ? [...selectedIds, ...ids.filter(i => !selectedIds.includes(i))] : ids)
      if (ids.length && isDrawTool) onBoxSelected?.()
      return
    }
    if (e.evt.button !== 0) return
    if (placeRef.current) { commitPlace(); return }
    if (ms && box) {
      cancelMarquee()
      if (box.width < 4 / zoom && box.height < 4 / zoom) { if (!ms.add) onSelect([]); return }
      const ids = markupsInBox(markups, box, lockedIds)
      onSelect(ms.add ? [...selectedIds, ...ids.filter(i => !selectedIds.includes(i))] : ids)
      return
    }
    if (!draft || !dragStart.current) return
    const g = draft.geometry
    const tiny = 4 / zoom
    if (draft.type === 'area') {
      const pts = (g as PathGeometry).points
      finish(Math.abs(pts[4]) < tiny * 3 || Math.abs(pts[5]) < tiny * 3 ? null : draft)
      return
    }
    if (draft.type === 'freehand') {
      const pts = simplify(freehandPts.current, 1 / zoom)
      finish(pts.length > 1 ? { ...draft, geometry: pathFromPoints(pts) } : null)
    } else if ('width' in g) {
      if (g.width < tiny && g.height < tiny) {
        // A click with the text tool drops a default-size box
        finish(draft.type === 'text' ? { ...draft, geometry: { ...g, width: 180, height: 40, ...(boxAlignRef.current !== null ? { rotation: boxAlignRef.current } : {}) } } : null)
      } else finish(draft)
    } else {
      const [, , x1, y1] = g.points
      if (tool === 'calibrate') {
        const a = { x: g.x, y: g.y }, b = { x: g.x + x1, y: g.y + y1 }
        finish(null)
        if (Math.hypot(x1, y1) >= tiny) onCalibrate(a, b)
        return
      }
      finish(Math.hypot(x1, y1) < tiny ? null : draft)
    }
  }

  latest.current = { handleDown, handleMove, handleUp, cancelGesture, startPlace, updatePlace, commitPlace } as never

  /** Drop the in-flight tap/drag (second finger, lost touch, long press). Points already placed on a polyline stay. */
  function cancelGesture() {
    const t = touch.current
    window.clearTimeout(t.timer)
    t.cancelled = true
    cancelMarquee()
    if (clickPts.current.length === 0) finish(null)
    const dd = (Konva.DD as unknown as { _dragElements: Map<number, { node: Konva.Node }> })._dragElements
    for (const el of [...dd.values()]) el.node.stopDrag()
    setSnapHint(null); setDevGhost(null)
  }

  const stagePoint = (ev: PointerEvent) => { stageRef.current?.setPointersPositions(ev); return pointer() }
  const asKonva = (ev: PointerEvent) => ({ evt: ev, target: stageRef.current! }) as unknown as Konva.KonvaEventObject<PointerEvent>

  function stopTouchListening() { touch.current.unlisten?.(); touch.current.unlisten = null }

  function onStageDown(e: Konva.KonvaEventObject<PointerEvent>) {
    const t = touch.current
    if (e.evt.pointerType !== 'touch') {
      t.cancelled = false; t.ev = null; t.dragged = false
      setTouchUi(false)
      handleDown(e)
      return
    }
    setTouchUi(true)
    const a = arb.current
    const r = a.down(e.evt.pointerId, e.evt.clientX, e.evt.clientY)
    if (r === 'cancel') { cancelGesture(); return }
    if (r !== 'start') return
    // First finger: classify, but commit nothing yet
    t.cancelled = false; t.dragged = false; t.ev = e; t.pt = pointer()
    const target = e.target
    t.handle = target.getParent()?.getClassName?.() === 'Transformer' || target.name() === 'point-handle'
    t.hitId = markupIdOf(target)
    const drawDrag = isDrawTool && (tool === 'area-rect' || DRAG_TOOLS.includes((tool === 'calibrate' ? 'line' : tool) as MarkupType))
    t.kind = drawDrag ? 'draw' : isDrawTool ? 'tap'
      : tool === 'select' && !t.handle && !t.hitId && boxSelect ? 'marquee' : 'other'
    // Markup drags, handles, drawing: the layer owns the finger. Everything else pans.
    consumedRef.current = isDrawTool ? drawDrag : tool === 'select' && (t.handle || !!t.hitId || boxSelect)
    window.clearTimeout(t.timer)
    if ((onContextMenu || tool === 'device') && !t.handle) {
      t.timer = window.setTimeout(() => {
        if (a.phase !== 'pending') return
        // Device tool, empty space: hold = place, then drag to turn it (the arbiter keeps following the finger)
        if (tool === 'device' && !markupAt(t.pt, t.hitId)
          && (latest.current as unknown as { startPlace: (p: Pt, x: number, y: number) => boolean }).startPlace(t.pt, e.evt.clientX, e.evt.clientY)) return
        if (!onContextMenu) return
        a.kill()
        cancelGesture()
        const hitId = markupAt(t.pt, t.hitId)
        if (hitId && !selectedIds.includes(hitId)) {
          const stk = stacks.byId.get(hitId)
          onSelect(stk ? stk.members.map(x => x.id).filter(i => !lockedIds.has(i)) : [hitId])
        }
        onContextMenu({ clientX: e.evt.clientX, clientY: e.evt.clientY, hitId, point: t.pt })
      }, tool === 'device' ? touchHoldMs(holdPref, general.longPressMs) : general.longPressMs)
    }
    if (!t.unlisten) {
      const mv = (ev: PointerEvent) => {
        if (ev.pointerType !== 'touch') return
        const res = a.move(ev.pointerId, ev.clientX, ev.clientY)
        if (res === 'none') return
        const h = latest.current as unknown as { handleDown: typeof handleDown; handleMove: typeof handleMove; updatePlace: typeof updatePlace }
        if (placeRef.current) {
          window.clearTimeout(t.timer)
          if (res === 'drag-start') t.dragged = true
          h.updatePlace(stagePoint(ev), false, ev.clientX, ev.clientY)
          return
        }
        if (res === 'drag-start') {
          window.clearTimeout(t.timer)
          t.dragged = true
          if ((t.kind === 'draw' || t.kind === 'marquee') && t.ev) {
            pointerOverride.current = t.pt
            try { h.handleDown(t.ev) } finally { pointerOverride.current = null }
          }
        }
        if (t.kind === 'draw' || t.kind === 'marquee') { stagePoint(ev); h.handleMove(asKonva(ev)) }
      }
      const up = (ev: PointerEvent) => {
        if (ev.pointerType !== 'touch') return
        const h = latest.current as unknown as { handleDown: typeof handleDown; handleUp: typeof handleUp; commitPlace: typeof commitPlace }
        const res = a.up(ev.pointerId)
        if (placeRef.current && (res === 'tap' || res === 'drag-end')) { window.clearTimeout(t.timer); h.commitPlace() }
        else if (res === 'tap') { window.clearTimeout(t.timer); tapAction(ev, h.handleDown) }
        else if (res === 'drag-end' && (t.kind === 'draw' || t.kind === 'marquee')) { stagePoint(ev); h.handleUp(asKonva(ev)) }
        if (a.count === 0) stopTouchListening()
      }
      const cancel = (ev: PointerEvent) => {
        if (ev.pointerType !== 'touch') return
        if (a.abort(ev.pointerId) === 'cancel') (latest.current as unknown as { cancelGesture: () => void }).cancelGesture()
        if (a.count === 0) stopTouchListening()
      }
      window.addEventListener('pointermove', mv)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      t.unlisten = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel) }
    }
  }

  /** A finished one-finger tap: this is where the tool finally acts. */
  function tapAction(ev: PointerEvent, down: typeof handleDown) {
    const t = touch.current
    const src = t.ev
    if (!src) return
    const p = t.pt
    const now = Date.now()
    const prevTap = t.lastTap
    t.lastTap = { x: p.x, y: p.y, t: now }
    if (t.kind === 'draw') {
      if (tool === 'text') {
        const b = boxFromDrag(p, p)
        finish({ ...newMarkup('text', { ...b, width: 180, height: 40 }) })
      }
      return // a tap with any other drawing tool makes nothing
    }
    // Double-tap closes a polyline / area / cable run
    if (t.kind === 'tap' && CLICK_PATHS.includes(tool as MarkupType) && clickPts.current.length >= 3
      && isDoubleTap(prevTap, p, now, 14 / zoom)) { finishClickPath(); t.lastTap = null; return }
    if (t.kind === 'marquee' || t.kind === 'other' || t.kind === 'tap') {
      if (t.kind === 'other' && tool === 'pan') return
      pointerOverride.current = p; tapMode.current = true
      try { down(src) } finally { pointerOverride.current = null; tapMode.current = false }
    }
    void ev
  }

  // A mouse placement released outside the canvas still commits
  const placing = !!placeView
  useEffect(() => {
    if (!placing) return
    const up = (ev: PointerEvent) => { if (ev.pointerType !== 'touch' && ev.button === 0) (latest.current as unknown as { commitPlace: () => void }).commitPlace() }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [placing])

  useEffect(() => () => { window.clearTimeout(touch.current.timer); touch.current.unlisten?.() }, [])

  function onTransformEnd() {
    const stage = stageRef.current
    if (!stage) return
    if (touch.current.cancelled) {
      // A second finger interrupted the resize/rotate: put every node back
      for (const m of selected) stage.findOne<Konva.Group>('#' + m.id)?.setAttrs({ x: m.geometry.x, y: m.geometry.y, rotation: 'rotation' in m.geometry ? m.geometry.rotation : 0, scaleX: 1, scaleY: 1 })
      stage.batchDraw()
      return
    }
    const change: Change = []
    for (const m of selected) {
      const node = stage.findOne<Konva.Group>('#' + m.id)
      if (!node) continue
      const base = { x: node.x(), y: node.y(), rotation: node.rotation() }
      const sx = node.scaleX(), sy = node.scaleY()
      node.scale({ x: 1, y: 1 })
      const geometry = 'points' in m.geometry
        ? bakePath({ ...base, points: m.geometry.points }, sx, sy)
        : { ...m.geometry, ...bakeBox({ ...base, width: m.geometry.width, height: m.geometry.height }, sx, sy) }
      // Stamps and text grow their lettering with the box
      const style = m.type === 'text' ? { ...m.style, fontSize: Math.max(6, Math.round(m.style.fontSize * Math.abs(sy))) } : m.style
      change.push({ before: m, after: { ...m, geometry, style } })
    }
    commit(change)
  }

  /** A point handle of a selected path is being dragged: its snapped position in the markup's local space, or null. */
  function snapHandle(m: Markup, _index: number, lx: number, ly: number, ev: Event): { x: number; y: number } | null {
    const g = m.geometry
    if (!('points' in g)) { showMark(null); return null }
    const a = (g.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
    const toLocal = (q: Pt) => { const dx = q.x - g.x, dy = q.y - g.y; return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos } }
    // The two ends of a cable snap to device centres first: dropping an end there locks it, dragging it off unlocks it
    if (m.type === 'cable' && (_index === 0 || _index === g.points.length / 2 - 1)) {
      const hit = cableDeviceSnap({ x: g.x + lx * cos - ly * sin, y: g.y + lx * sin + ly * cos }, ev)
      if (hit) return toLocal(hit.point)
    }
    if (!snapActive(snapEnv, ctrlOf(ev))) { showMark(null); return null }
    const hit = snapPoint(snapEnv, { x: g.x + lx * cos - ly * sin, y: g.y + lx * sin + ly * cos }, liveZoom(), { skip: new Set([m.id]) })
    showMark(hit)
    if (!hit) return null
    return toLocal(hit.point)
  }

  /** The markups a Ctrl+drag of `id` copies (one device when dragging out of a stack). */
  function copySources(id: string): Markup[] {
    const grp = stacks.byId.get(id)
    const srcIds = grp ? [id] : selectedIds.includes(id) ? selectedIds : [id]
    return srcIds.map(i => byId.get(i)).filter((m): m is Markup => !!m && !lockedIds.has(m.id) && !isSheetArea(m))
  }

  /**
   * A markup is being dragged: line its handles (a device's centre, a box's corners and centre, a path's vertices) up with
   * whatever snaps. A lone device or box also turns to the line it lands on when Align to walls is on.
   */
  function onShapeDragMove(e: Konva.KonvaEventObject<DragEvent>) {
    const node = e.target
    const id = markupIdOf(node)
    const m = id ? byId.get(id) : undefined
    if (!id || !m) return
    const orig = m.geometry
    if (node.rotation() !== orig.rotation) node.rotation(orig.rotation) // undo last frame's alignment before measuring
    dragAlignRef.current = null
    if (copyDrag.current || !snapActive(snapEnv, ctrlOf(e.evt))) { showMark(null); return }
    const moving = new Set(selectedIds.includes(id) ? selectedIds : (stacks.byId.get(id)?.members.map(x => x.id) ?? [id]))
    const cur: Markup = { ...m, geometry: { ...orig, x: node.x(), y: node.y() } }
    const res = snapHandles(snapEnv, handlePoints(cur), liveZoom(), { skip: moving })
    if (!res) { showMark(null); return }
    showMark(res.hit)
    const moved = { ...orig, x: node.x() + res.dx, y: node.y() + res.dy }
    if (moving.size === 1 && snapSettings.align && alignable(res.hit) && 'width' in moved) {
      let g: BoxGeometry | null = null
      if (m.type === 'device') g = alignDevice(moved, res.hit, res.handle, typeMountOf(m, catalog))
      else if (ALIGN_BOX_TYPES.has(m.type)) g = alignBox(moved, res.hit.point, res.hit.angle)
      if (g) {
        node.position({ x: g.x, y: g.y })
        node.rotation(g.rotation)
        dragAlignRef.current = { id, geometry: g }
        if (g.fov && m.type === 'device') setFovOverride({ id, fov: g.fov })
        return
      }
    }
    node.position({ x: moved.x, y: moved.y })
  }

  function onDragStart(e: Konva.KonvaEventObject<DragEvent>) {
    dragAlignRef.current = null
    const id = markupIdOf(e.target)
    if (!id || e.target.name() !== 'markup' || readOnly || !(e.evt.ctrlKey || e.evt.metaKey)) return
    copyDrag.current = true
    setCopyGhosts(copySources(id).filter(m => m.id === id || !stacks.byId.get(id)))
  }

  function onDragEnd(e: Konva.KonvaEventObject<DragEvent>) {
    const wasCopy = copyDrag.current
    copyDrag.current = false
    setCopyGhosts(null)
    setSnapMark(null)
    const aligned = dragAlignRef.current
    dragAlignRef.current = null
    setFovOverride(cur => (cur && aligned && cur.id === aligned.id ? null : cur))
    const stage = stageRef.current
    const id = markupIdOf(e.target)
    if (!stage || !id || e.target.name() !== 'markup') return
    const tc = touch.current
    if (tc.cancelled || (tc.ev && !tc.dragged)) {
      // Drag interrupted by a second finger, or a "drag" that never left the tap slop: back to where it was
      const orig = byId.get(id)
      if (orig) { e.target.position({ x: orig.geometry.x, y: orig.geometry.y }); e.target.rotation(orig.geometry.rotation); e.target.getLayer()?.batchDraw() }
      setCopyGhosts(null)
      return
    }
    // Everything selected moves rigidly with the dragged node (a stack's members move as one step)
    const dragged = byId.get(id)
    if (!dragged) return
    if (aligned && aligned.id === id && !wasCopy && !(e.evt.ctrlKey || e.evt.metaKey) && !lockedIds.has(id)) {
      // A lone device / box that turned to the line it landed on: move and turn in one step
      commit([{ before: dragged, after: { ...dragged, geometry: aligned.geometry } }])
      if (!selectedIds.includes(id)) onSelect([id])
      return
    }
    const dx = e.target.x() - dragged.geometry.x, dy = e.target.y() - dragged.geometry.y
    if (dx === 0 && dy === 0) return
    const grp = stacks.byId.get(id)
    if (wasCopy || e.evt.ctrlKey || e.evt.metaKey) {
      // Ctrl+drag: the original stays and a copy lands at the drop point (one device when dragging out of a stack)
      e.target.position({ x: dragged.geometry.x, y: dragged.geometry.y })
      e.target.getLayer()?.batchDraw()
      if (readOnly) return
      const copies = copySources(id)
        .map(m => copyMarkup(m, { dx, dy, set: m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined }))
      if (!copies.length) return
      commit(copies.map(after => ({ before: null, after })))
      onSelect(copies.map(c => c.id))
      return
    }
    const ids = selectedIds.includes(id) ? selectedIds : grp ? grp.members.map(x => x.id) : [id]
    const change: Change = []
    for (const mid of ids) {
      const m = byId.get(mid)
      if (!m || lockedIds.has(mid)) continue
      change.push({ before: m, after: { ...m, geometry: { ...m.geometry, x: m.geometry.x + dx, y: m.geometry.y + dy } } })
    }
    commit(change)
    if (!selectedIds.includes(id)) onSelect(grp ? grp.members.map(x => x.id) : [id])
  }

  // Konva reports two quick clicks anywhere as a double-click; only finish when both
  // clicks land on the same spot, so fast point placement isn't cut short.
  function onDoubleClick() {
    const pts = clickPts.current
    if (pts.length < 3) return
    const a = pts[pts.length - 3], b = pts[pts.length - 2]
    if (Math.hypot(a.x - b.x, a.y - b.y) < 8 / zoom) finishClickPath()
  }

  // Count markers number 1, 2, 3... within their session group
  const countNumbers = new Map<string, number>()
  {
    const groups = new Map<string, Markup[]>()
    for (const m of markups) if (m.type === 'count') {
      const k = String(m.fields?.group ?? m.id)
      groups.set(k, [...(groups.get(k) ?? []), m])
    }
    for (const list of groups.values()) {
      list.sort((a, b) => Number(a.fields?.n ?? 0) - Number(b.fields?.n ?? 0))
      list.forEach((m, i) => countNumbers.set(m.id, i + 1))
    }
  }

  const canDrag = (m: Markup) => tool === 'select' && !readOnly && !lockedIds.has(m.id) && !isSheetArea(m)

  // Areas draw first (below everything) so they never cover devices
  const drawable = markups.filter(hasDrawableGeometry)
  const ordered = [...drawable.filter(m => m.type === 'area'), ...drawable.filter(m => m.type !== 'area')]

  const multiPointActive = touchUi && !!draft && CLICK_PATHS.includes(draft.type) && !readOnly
  const btn: React.CSSProperties = { minHeight: 44, padding: '0 20px', borderRadius: 22, border: '1px solid var(--border, #888)', background: 'var(--surface, #fff)', color: 'inherit', font: 'inherit', fontWeight: 600, boxShadow: '0 4px 16px rgb(0 0 0 / 0.3)' }

  return (
    <>
    <Stage ref={stageRef} width={width} height={height} className={devGhost ? 'markup-stage no-cursor' : 'markup-stage'}
      onPointerDown={onStageDown} onPointerMove={e => { if (e.evt.pointerType === 'touch') return; handleMove(e) }} onPointerUp={e => { if (e.evt.pointerType === 'touch') return; handleUp(e) }} onPointerLeave={() => { onCursor?.(null); setDevGhost(null) }}
      onDblClick={onDoubleClick}>
      <Layer>
        {snapSettings.showGrid && snapEnv.gridStep > 0 && (
          <Shape listening={false} stroke="rgba(25,113,194,0.3)" strokeWidth={1} strokeScaleEnabled={false} sceneFunc={(ctx, shape) => {
            const stage = shape.getStage()
            if (!stage) return
            const z = stage.scaleX() || 1
            const step = snapEnv.gridStep
            if (step * z < GRID_DRAW_MIN_PX) return
            const inv = stage.getAbsoluteTransform().copy().invert()
            const a = inv.point({ x: 0, y: 0 }), b = inv.point({ x: stage.width(), y: stage.height() })
            const x0 = Math.floor(a.x / step) * step, y0 = Math.floor(a.y / step) * step
            if (((b.x - a.x) / step + 1) * 2 + ((b.y - a.y) / step + 1) * 2 > 6000) return
            ctx.beginPath()
            for (let x = x0; x <= b.x; x += step) { ctx.moveTo(x, a.y); ctx.lineTo(x, b.y) }
            for (let y = y0; y <= b.y; y += step) { ctx.moveTo(a.x, y); ctx.lineTo(b.x, y) }
            ctx.fillStrokeShape(shape)
          }} />
        )}
        {ordered.map(m => {
          const shown = pointOverride?.id === m.id && 'points' in m.geometry
            ? { ...m, geometry: { ...m.geometry, points: pointOverride.points } }
            : fovOverride?.id === m.id && 'width' in m.geometry
            ? { ...m, geometry: { ...m.geometry, fov: fovOverride.fov } } : m
          const editable = single?.id === m.id && !readOnly && tool === 'select'
            && 'points' in m.geometry && m.type !== 'freehand' && !lockedIds.has(m.id) && !isSheetArea(m)
          const stk = stacks.byId.get(m.id)
          const isCable = m.type === 'cable'
          const len = isCable && scale ? cableLength(m, scale, cableDefaults ?? DEFAULT_CABLE_SETTINGS, byId) : null
          const drawn = isCable ? { ...shown, style: { ...shown.style, stroke: cableColor(m, catalog?.cableTypes) } } : shown
          return (
            <MarkupShape key={m.id} markup={drawn}
              dangling={isCable ? danglingEnds(m, byId) : undefined}
              cableLabel={len ? `${formatFeetInches(len.runFt)}${len.count > 1 ? ` x${len.count}` : ''}` : undefined}
              ghost={!!stk && stackTop(stk).id !== m.id}
              stack={stk && stackTop(stk).id === m.id ? { count: stk.members.length, label: tagRange(stk.members.map(x => x.tag ?? '')), statuses: stk.members.map(x => x.status ?? '') } : undefined} zoom={zoom} scale={scale} countNumber={countNumbers.get(m.id)}
              areaPath={m.type === 'area' ? areaPaths.get(m.id) : undefined}
              symbolSet={m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined}
              iconSrc={m.type === 'device' ? deviceIcon(m, m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined, catalog) : undefined}
              typeMount={m.type === 'device' ? typeMountOf(m, catalog) : undefined}
              showCones={showCones}
              legendRows={m.type === 'legend' ? legendRows?.get(m.id) : undefined}
              editFov={(single?.id === m.id || (selectedIds.includes(m.id) && !!stacks.byId.get(m.id) && selectedIds.every(i => stacks.byId.get(m.id)!.members.some(x => x.id === i)))) && !readOnly && tool === 'select' && !lockedIds.has(m.id)}
              onFovChange={(fov, done) => {
                if (!done) { setFovOverride({ id: m.id, fov }); return }
                setFovOverride(null)
                if (touch.current.cancelled) return
                commit([{ before: m, after: { ...m, geometry: { ...(m.geometry as BoxGeometry), fov } } }])
              }}
              draggable={canDrag(m)}
              listening={!lockedIds.has(m.id) && !isDrawTool}
              editPoints={editable}
              snapHandle={snapHandle}
              onPointsChange={(points, done) => {
                if (!done) { setPointOverride({ id: m.id, points }); return }
                setPointOverride(null)
                setSnapMark(null)
                if (touch.current.cancelled) return
                const moved = { ...(m.geometry as PathGeometry), points }
                commit([{ before: m, after: { ...m, geometry: m.type === 'cable' ? relinkEnds(moved, byId, m.page) : moved } }])
              }}
              onDragStart={onDragStart} onDragMove={canDrag(m) ? onShapeDragMove : undefined} onDragEnd={onDragEnd} />
          )
        })}
        {copyGhosts?.map(g => (
          <MarkupShape key={`copy-ghost:${g.id}`} markup={{ ...g, id: `copy-ghost:${g.id}` }} zoom={zoom} scale={scale} listening={false}
            symbolSet={g.symbol_set_id ? symbolSets.get(g.symbol_set_id) : undefined}
            iconSrc={g.type === 'device' ? deviceIcon(g, g.symbol_set_id ? symbolSets.get(g.symbol_set_id) : undefined, catalog) : undefined}
            typeMount={g.type === 'device' ? typeMountOf(g, catalog) : undefined}
            showCones={showCones} areaPath={g.type === 'area' ? areaPaths.get(g.id) : undefined} />
        ))}
        {marquee && <Rect x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} listening={false}
          stroke="#1971c2" strokeWidth={1.5 / zoom} dash={[6 / zoom, 4 / zoom]} fill="rgba(25,113,194,0.12)" />}
        {snapHint && <Circle x={snapHint.x} y={snapHint.y} radius={snapHint.r * 1.2} listening={false}
          stroke="#1971c2" strokeWidth={1.5 / zoom} dash={[4 / zoom, 3 / zoom]} opacity={0.7} />}
        {devGhost && newBase.symbolSetId && symbolSets.get(newBase.symbolSetId) && (() => {
          const set = symbolSets.get(newBase.symbolSetId!)!
          const ghostFov = initialCoverage(set, newBase.deviceTypeId ? catalog?.types.get(newBase.deviceTypeId)?.coverage : null, scale ?? null)
          const gm = newMarkup('device', ghostGeo ?? { x: devGhost.x - 12 * (props.deviceScale ?? 1), y: devGhost.y - 12 * (props.deviceScale ?? 1), width: 24 * (props.deviceScale ?? 1), height: 24 * (props.deviceScale ?? 1), rotation: 0, ...(ghostFov ? { fov: ghostFov } : {}) })
          return (
            <Group opacity={0.5} listening={false}>
              <MarkupShape markup={{ ...gm, id: 'device-cursor-ghost' }} zoom={zoom} scale={scale} listening={false} symbolSet={set} showCones={false}
                iconSrc={deviceIcon(gm, set, catalog)} typeMount={newBase.deviceTypeId ? catalog?.types.get(newBase.deviceTypeId)?.mount : undefined} />
            </Group>
          )
        })()}
        {placeView && newBase.symbolSetId && symbolSets.get(newBase.symbolSetId) && (() => {
          const set = symbolSets.get(newBase.symbolSetId!)!
          const gm = placeView.m
          const c = placeRef.current?.c
          return (
            <>
              <MarkupShape markup={gm} zoom={zoom} scale={scale} listening={false} symbolSet={set} showCones={showCones}
                iconSrc={deviceIcon(gm, set, catalog)} typeMount={typeMountOf(gm, catalog)} />
              {c && placeView.to && placeView.angle !== null && (
                <>
                  <Line points={[c.x, c.y, placeView.to.x, placeView.to.y]} listening={false} stroke="#1971c2" strokeWidth={1 / zoom} dash={[4 / zoom, 3 / zoom]} opacity={0.8} />
                  <Group x={placeView.to.x} y={placeView.to.y} scaleX={1 / zoom} scaleY={1 / zoom} listening={false}>
                    <Label x={12} y={12}>
                      <Tag fill="#1971c2" cornerRadius={3} />
                      <Text text={angleLabel(placeView.angle)} fill="#fff" fontSize={11} padding={3} />
                    </Label>
                  </Group>
                </>
              )}
            </>
          )
        })()}
        {draft && <MarkupShape markup={draft} zoom={zoom} scale={scale} listening={false} />}
        {snapMark && <SnapMarker x={snapMark.x} y={snapMark.y} kind={snapMark.kind} zoom={zoom} />}
        {calLine && <MarkupShape zoom={zoom} listening={false}
          markup={{ id: 'calibration', document_id: '', page: 0, type: 'line', geometry: pathFromPoints(calLine), style: CAL_STYLE, text: '', layer_id: null }} />}
        {peers?.map(p => {
          const boxes = (general.showSelections ? p.selection : []).map(id => byId.get(id)).filter((x): x is Markup => !!x).map(x => ({ id: x.id, b: markupBounds(x) }))
          return boxes.map(({ id, b }) => (
            <Rect key={`${p.clientId}:${id}`} x={b.x - 3 / zoom} y={b.y - 3 / zoom} width={b.width + 6 / zoom} height={b.height + 6 / zoom}
              listening={false} stroke={p.color} strokeWidth={2 / zoom} dash={[6 / zoom, 3 / zoom]} cornerRadius={2 / zoom} />
          )).concat(boxes.length ? [(
            <Group key={`${p.clientId}:sel-tag`} x={boxes[0].b.x - 3 / zoom} y={boxes[0].b.y - 3 / zoom} scaleX={1 / zoom} scaleY={1 / zoom} listening={false}>
              <Label y={-16}>
                <Tag fill={p.color} cornerRadius={3} />
                <Text text={p.name} fill="#fff" fontSize={10} padding={2} />
              </Label>
            </Group>
          )] : [])
        })}
        {Object.entries(held).map(([id, h]) => {
          const age = h.ended === null ? 0 : Date.now() - h.ended
          const op = age < 2000 ? 1 : Math.max(0, 1 - (age - 2000) / 1000)
          return (
            <Group key={`${id}:mq`} x={h.r.x} y={h.r.y} opacity={op} listening={false}>
              <Rect width={h.r.w} height={h.r.h} fill={h.color + '26'} stroke={h.color} strokeWidth={1.5 / zoom} dash={[6 / zoom, 3 / zoom]} />
              <Group scaleX={1 / zoom} scaleY={1 / zoom}>
                <Label y={-16}>
                  <Tag fill={h.color} cornerRadius={3} />
                  <Text text={h.name} fill="#fff" fontSize={10} padding={2} />
                </Label>
              </Group>
            </Group>
          )
        })}
        {peers?.map(p => general.showViewRects && p.viewport && (
          <Group key={`${p.clientId}:vp`} x={p.viewport.x} y={p.viewport.y} listening={false}>
            <Rect width={p.viewport.w} height={p.viewport.h} stroke={p.color} strokeWidth={1.5 / zoom} dash={[8 / zoom, 5 / zoom]} opacity={0.5} />
            <Group scaleX={1 / zoom} scaleY={1 / zoom}>
              <Label opacity={0.7}>
                <Tag fill={p.color} />
                <Text text={p.name} fill="#fff" fontSize={10} padding={2} />
              </Label>
            </Group>
          </Group>
        ))}
        {peers?.map(p => general.showCursors && p.cursor && (
          // Sized in screen pixels: the group is scaled by 1/zoom
          <Group key={p.clientId} x={p.cursor.x} y={p.cursor.y} scaleX={1 / zoom} scaleY={1 / zoom} listening={false}>
            <Line points={[0, 0, 0, 16, 4, 12.5, 7.5, 19, 10.5, 17.5, 7, 11.5, 12, 11]} closed fill={p.color} stroke="#fff" strokeWidth={1} lineJoin="round" />
            <Label x={12} y={18}>
              <Tag fill={p.color} cornerRadius={3} />
              <Text text={p.name} fill="#fff" fontSize={11} padding={3} />
            </Label>
          </Group>
        ))}
        <Transformer ref={trRef} rotateEnabled keepRatio={selected.length > 0 && selected.every(m => m.type === 'device')} ignoreStroke flipEnabled={false}
          rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]} rotationSnapTolerance={snapSettings.on && snapSettings.align ? 5 : 4}
          anchorSize={11} anchorCornerRadius={2} borderStroke={REDLINE} anchorStroke={REDLINE}
          boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
          onTransformEnd={onTransformEnd} />
      </Layer>
    </Stage>
    {multiPointActive && createPortal(
      <div data-no-pan style={{ position: 'fixed', left: 0, right: 0, bottom: 24, zIndex: 'var(--z-popover)' as unknown as number, display: 'flex', gap: 12, justifyContent: 'center', pointerEvents: 'none', touchAction: 'manipulation' }}>
        <button type="button" style={{ ...btn, pointerEvents: 'auto' }} onClick={() => { cancelMarquee(); finish(null) }}>Cancel</button>
        <button type="button" style={{ ...btn, pointerEvents: 'auto', background: REDLINE, color: '#fff', borderColor: REDLINE }} onClick={finishClickPath}>Finish</button>
      </div>, document.body)}
    </>
  )
})

/** The snap indicator: a small mark at the snapped point, shaped by what it snapped to. Sized in screen pixels. */
function SnapMarker({ x, y, kind, zoom }: { x: number; y: number; kind: SnapKind; zoom: number }) {
  const c = '#e8590c'
  const common = { stroke: c, strokeWidth: 2, listening: false, fillEnabled: false } as const
  return (
    <Group x={x} y={y} scaleX={1 / zoom} scaleY={1 / zoom} listening={false}>
      {kind === 'device' && <Circle radius={7} {...common} />}
      {kind === 'endpoint' && <Rect x={-5} y={-5} width={10} height={10} {...common} />}
      {kind === 'midpoint' && <Line points={[0, -6, 6, 5, -6, 5]} closed {...common} />}
      {kind === 'edge' && <Line points={[-5, -5, 5, 5]} {...common} />}
      {kind === 'edge' && <Line points={[-5, 5, 5, -5]} {...common} />}
      {kind === 'pdf' && <Line points={[0, -7, 7, 0, 0, 7, -7, 0]} closed {...common} />}
      {kind === 'grid' && <Line points={[-6, 0, 6, 0]} {...common} />}
      {kind === 'grid' && <Line points={[0, -6, 0, 6]} {...common} />}
    </Group>
  )
}
