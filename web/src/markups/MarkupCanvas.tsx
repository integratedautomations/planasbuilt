import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Circle, Group, Label, Layer, Line, Rect, Stage, Tag, Text, Transformer } from 'react-konva'
import Konva from 'konva'
import { bakeBox, bakePath, boxFromDrag, pathFromPoints, simplify, snap45 } from './geometry'
import type { Pt } from './geometry'
import { MarkupShape } from './MarkupShape'
import type { Change } from './useMarkups'
import { isSheetArea } from './areas'
import { deviceRadius, findSnapTarget, stackTop, tagRange } from './stacks'
import type { StackIndex } from './stacks'
import { deviceCenter } from './geometry'
import { markupBounds, markupsInBox, rectFromCorners, rectsIntersect } from './selection'
import { copyMarkup } from './copy'
import type { Rect as Box } from './selection'
import { AREA_STYLE, isBoxType } from './types'
import { deviceIcon } from '../catalog/catalog'
import { DEFAULT_LEGEND, legendFields } from './legend'
import type { LegendRow } from './legend'
import type { Catalog } from '../catalog/catalog'
import type { BoxGeometry, Fov, Markup, MarkupStyle, MarkupType, PathGeometry, SymbolSet, Tool } from './types'
import { uuid } from '../uuid'
import type { Peer } from '../realtime/presence'

// Only the left button drags markups: middle pans the plan and right box-selects.
Konva.dragButtons = [0]

/** A plain right-click: where it happened and which markup (if any) is under it. */
export interface ContextInfo { clientX: number; clientY: number; hitId: string | null; point: Pt }

export interface MarkupCanvasHandle {
  stage: () => Konva.Stage | null
  cancelDraft: () => void
  finishDraft: () => void
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
  /** Live rows of each legend on this page (by markup id). */
  legendRows?: Map<string, LegendRow[]>
  /** Device stacks on this page (same-set devices on one spot). */
  stacks: StackIndex
  /** Other people on this page (cursor + selection are drawn in their colour). */
  peers?: Peer[]
  /** Pointer position in page coordinates, or null when it left the canvas. Omitted when cursors are not broadcast. */
  onCursor?: (p: Pt | null) => void
  /** Right-click without dragging. */
  onContextMenu?: (info: ContextInfo) => void
  /** Drawn rectangles/ellipses are forced to squares/circles (Square and Circle tools). */
  constrain?: boolean
}

const TWO_POINT: MarkupType[] = ['line', 'arrow', 'measure-length']
const CLICK_PATHS: MarkupType[] = ['polyline', 'polygon', 'cable', 'measure-polylength', 'measure-area', 'area']
const CLOSED: MarkupType[] = ['polygon', 'measure-area', 'area']
const rectPoints = (a: Pt, b: Pt): Pt[] => [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
const DRAG_TOOLS: MarkupType[] = ['line', 'arrow', 'measure-length', 'rect', 'ellipse', 'cloud', 'highlight', 'text', 'freehand']

const CAL_STYLE: MarkupStyle = { stroke: '#1971c2', fill: '', strokeWidth: 2, opacity: 1, fontSize: 18, dash: true }

export const MarkupCanvas = forwardRef<MarkupCanvasHandle, Props>(function MarkupCanvas(props, ref) {
  const { width, height, zoom, markups, lockedIds, tool, readOnly, selectedIds, onSelect, commit, newBase, symbolSets, catalog, consumedRef, onCreated, scale, onCalibrate, calLine, areaPaths, boxSelect, multiSelect, showCones, legendRows, stacks, peers, onCursor, onContextMenu, constrain } = props
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
  const [snapHint, setSnapHint] = useState<{ x: number; y: number; r: number } | null>(null)
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

  const pointer = (): Pt => stageRef.current!.getRelativePointerPosition() ?? { x: 0, y: 0 }

  const newMarkup = (type: MarkupType, geometry: BoxGeometry | PathGeometry): Markup => ({
    id: uuid(), document_id: newBase.document_id, page: newBase.page, type, geometry,
    style: type === 'area' ? { ...AREA_STYLE } : { ...newBase.style }, text: type === 'stamp' ? newBase.stampText : '', layer_id: newBase.layer_id,
    ...(type === 'device' ? { symbol_set_id: newBase.symbolSetId, device_type_id: newBase.deviceTypeId ?? null, product_id: newBase.productId ?? null, tag: '', status: 'planned' as const, fields: { ...newBase.deviceFields } } : {}),
  })

  const finish = (m: Markup | null) => {
    setDraft(null)
    dragStart.current = null
    freehandPts.current = []
    clickPts.current = []
    if (!m) return
    commit([{ before: null, after: m }])
    onSelect([m.id])
    onCreated?.(m)
  }

  const finishClickPath = () => {
    if (!draft || !CLICK_PATHS.includes(draft.type)) return
    // Drop the rubber-band point and any double-click duplicate
    const pts = clickPts.current.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.5)
    const min = CLOSED.includes(draft.type) ? 3 : 2
    finish(pts.length >= min ? newMarkup(draft.type, pathFromPoints(pts)) : null)
  }

  const cancelMarquee = () => { marqueeStart.current = null; marqueeRect.current = null; setMarquee(null) }

  useImperativeHandle(ref, () => ({
    stage: () => stageRef.current,
    cancelDraft: () => { cancelMarquee(); finish(null) },
    finishDraft: finishClickPath,
  }))

  // Leaving a tool abandons its half-drawn markup
  useEffect(() => { cancelMarquee(); finish(null); countGroup.current = null; setSnapHint(null) }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps

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

  function onPointerDown(e: Konva.KonvaEventObject<PointerEvent>) {
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
      } else if (boxSelect || e.evt.shiftKey) {
        consumedRef.current = true // empty space with Shift / box mode: marquee
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
      dragStart.current = p
      setDraft(newMarkup('area', pathFromPoints(rectPoints(p, p))))
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
      const size = 24
      // Close to a device of the same set: land exactly on it so it joins its stack
      const snap = findSnapTarget(markups, p, set.id, 1.2, newBase.deviceTypeId ?? null)
      setSnapHint(null)
      if (snap) {
        const sg = snap.geometry as BoxGeometry
        finish(newMarkup('device', {
          x: sg.x, y: sg.y, width: sg.width, height: sg.height, rotation: sg.rotation,
          ...(set.has_fov ? { fov: { direction: -90, angle: 90, range: 150 } } : {}),
        }))
        return
      }
      finish(newMarkup('device', {
        x: p.x - size / 2, y: p.y - size / 2, width: size, height: size, rotation: 0,
        ...(set.has_fov ? { fov: { direction: -90, angle: 90, range: 150 } } : {}),
      }))
      return
    }
    if (t === 'count') {
      const grp = countGroup.current ?? (countGroup.current = { id: uuid(), n: 0 })
      grp.n++
      const m = newMarkup('count', pathFromPoints([p]))
      commit([{ before: null, after: { ...m, fields: { group: grp.id, n: grp.n } } }])
      return
    }
    if (CLICK_PATHS.includes(t)) {
      const pts = clickPts.current
      if (!pts.length) {
        clickPts.current = [p, p]
      } else {
        const first = pts[0]
        if (CLOSED.includes(t) && pts.length >= 4 && Math.hypot(p.x - first.x, p.y - first.y) < 10 / zoom) {
          clickPts.current = pts.slice(0, -1)
          setDraft(newMarkup(t, pathFromPoints(clickPts.current)))
          finishClickPath()
          return
        }
        const last = e.evt.shiftKey ? snap45(pts[pts.length - 2], p) : p
        clickPts.current = [...pts.slice(0, -1), last, last]
      }
      setDraft(newMarkup(t, pathFromPoints(clickPts.current)))
      return
    }
    if (DRAG_TOOLS.includes(t)) {
      dragStart.current = p
      freehandPts.current = [p]
      const base = newMarkup(t, isBoxType(t) ? boxFromDrag(p, p) : pathFromPoints([p, p]))
      setDraft(cal ? { ...base, style: CAL_STYLE } : base)
    }
  }

  function onPointerMove(e: Konva.KonvaEventObject<PointerEvent>) {
    if (onCursor) onCursor(stageRef.current?.getRelativePointerPosition() ?? null)
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
    if (tool === 'device' && !draft && !readOnly) {
      const t = findSnapTarget(markups, pointer(), newBase.symbolSetId, 1.2, newBase.deviceTypeId ?? null)
      if (t) {
        const c = deviceCenter(t.geometry as BoxGeometry)
        setSnapHint(h => (h && h.x === c.x && h.y === c.y ? h : { ...c, r: deviceRadius(t.geometry as BoxGeometry) }))
      } else setSnapHint(h => (h ? null : h))
      return
    }
    if (!draft) return
    const p = pointer()
    const shift = e.evt.shiftKey
    if (CLICK_PATHS.includes(draft.type) && !dragStart.current) {
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
      setDraft({ ...draft, geometry: boxFromDrag(a, p, shift || !!constrain) })
    } else {
      setDraft({ ...draft, geometry: pathFromPoints([a, shift ? snap45(a, p) : p]) })
    }
  }

  function onPointerUp(e: Konva.KonvaEventObject<PointerEvent>) {
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
      return
    }
    if (e.evt.button !== 0) return
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
        finish(draft.type === 'text' ? { ...draft, geometry: { ...g, width: 180, height: 40 } } : null)
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

  function onTransformEnd() {
    const stage = stageRef.current
    if (!stage) return
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

  function onDragEnd(e: Konva.KonvaEventObject<DragEvent>) {
    const stage = stageRef.current
    const id = markupIdOf(e.target)
    if (!stage || !id || e.target.name() !== 'markup') return
    // Everything selected moves rigidly with the dragged node (a stack's members move as one step)
    const dragged = byId.get(id)
    if (!dragged) return
    const dx = e.target.x() - dragged.geometry.x, dy = e.target.y() - dragged.geometry.y
    if (dx === 0 && dy === 0) return
    const grp = stacks.byId.get(id)
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Ctrl+drag: the original stays and a copy lands at the drop point (one device when dragging out of a stack)
      e.target.position({ x: dragged.geometry.x, y: dragged.geometry.y })
      e.target.getLayer()?.batchDraw()
      if (readOnly) return
      const srcIds = grp ? [id] : selectedIds.includes(id) ? selectedIds : [id]
      const copies = srcIds.map(i => byId.get(i)).filter((m): m is Markup => !!m && !lockedIds.has(m.id) && !isSheetArea(m))
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
  const ordered = [...markups.filter(m => m.type === 'area'), ...markups.filter(m => m.type !== 'area')]

  return (
    <Stage ref={stageRef} width={width} height={height} className="markup-stage"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => onCursor?.(null)}
      onDblClick={onDoubleClick} onDblTap={onDoubleClick}>
      <Layer>
        {ordered.map(m => {
          const shown = pointOverride?.id === m.id && 'points' in m.geometry
            ? { ...m, geometry: { ...m.geometry, points: pointOverride.points } }
            : fovOverride?.id === m.id && 'width' in m.geometry
            ? { ...m, geometry: { ...m.geometry, fov: fovOverride.fov } } : m
          const editable = single?.id === m.id && !readOnly && tool === 'select'
            && 'points' in m.geometry && m.type !== 'freehand' && !lockedIds.has(m.id) && !isSheetArea(m)
          const stk = stacks.byId.get(m.id)
          return (
            <MarkupShape key={m.id} markup={shown}
              ghost={!!stk && stackTop(stk).id !== m.id}
              stack={stk && stackTop(stk).id === m.id ? { count: stk.members.length, label: tagRange(stk.members.map(x => x.tag ?? '')), statuses: stk.members.map(x => x.status ?? '') } : undefined} zoom={zoom} scale={scale} countNumber={countNumbers.get(m.id)}
              areaPath={m.type === 'area' ? areaPaths.get(m.id) : undefined}
              symbolSet={m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined}
              iconSrc={m.type === 'device' ? deviceIcon(m, m.symbol_set_id ? symbolSets.get(m.symbol_set_id) : undefined, catalog) : undefined}
              showCones={showCones}
              legendRows={m.type === 'legend' ? legendRows?.get(m.id) : undefined}
              editFov={single?.id === m.id && !readOnly && tool === 'select' && !lockedIds.has(m.id)}
              onFovChange={(fov, done) => {
                if (!done) { setFovOverride({ id: m.id, fov }); return }
                setFovOverride(null)
                commit([{ before: m, after: { ...m, geometry: { ...(m.geometry as BoxGeometry), fov } } }])
              }}
              draggable={canDrag(m)}
              listening={!lockedIds.has(m.id) && !isDrawTool}
              editPoints={editable}
              onPointsChange={(points, done) => {
                if (!done) { setPointOverride({ id: m.id, points }); return }
                setPointOverride(null)
                commit([{ before: m, after: { ...m, geometry: { ...(m.geometry as PathGeometry), points } } }])
              }}
              onDragEnd={onDragEnd} />
          )
        })}
        {marquee && <Rect x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} listening={false}
          stroke="#1971c2" strokeWidth={1.5 / zoom} dash={[6 / zoom, 4 / zoom]} fill="rgba(25,113,194,0.12)" />}
        {snapHint && <Circle x={snapHint.x} y={snapHint.y} radius={snapHint.r * 1.2} listening={false}
          stroke="#1971c2" strokeWidth={1.5 / zoom} dash={[4 / zoom, 3 / zoom]} opacity={0.7} />}
        {draft && <MarkupShape markup={draft} zoom={zoom} scale={scale} listening={false} />}
        {calLine && <MarkupShape zoom={zoom} listening={false}
          markup={{ id: 'calibration', document_id: '', page: 0, type: 'line', geometry: pathFromPoints(calLine), style: CAL_STYLE, text: '', layer_id: null }} />}
        {peers?.map(p => {
          const boxes = p.selection.map(id => byId.get(id)).filter((x): x is Markup => !!x).map(x => ({ id: x.id, b: markupBounds(x) }))
          return boxes.map(({ id, b }) => (
            <Rect key={`${p.clientId}:${id}`} x={b.x - 3 / zoom} y={b.y - 3 / zoom} width={b.width + 6 / zoom} height={b.height + 6 / zoom}
              listening={false} stroke={p.color} strokeWidth={2 / zoom} dash={[6 / zoom, 3 / zoom]} cornerRadius={2 / zoom} />
          ))
        })}
        {peers?.map(p => p.cursor && (
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
          rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]} rotationSnapTolerance={4}
          anchorSize={11} anchorCornerRadius={2} borderStroke="#1971c2" anchorStroke="#1971c2"
          boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
          onTransformEnd={onTransformEnd} />
      </Layer>
    </Stage>
  )
})
