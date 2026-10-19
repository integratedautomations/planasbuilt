import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Layer, Stage, Transformer } from 'react-konva'
import type Konva from 'konva'
import { bakeBox, bakePath, boxFromDrag, pathFromPoints, simplify, snap45 } from './geometry'
import type { Pt } from './geometry'
import { MarkupShape } from './MarkupShape'
import type { Change } from './useMarkups'
import { isBoxType } from './types'
import type { BoxGeometry, Markup, MarkupStyle, MarkupType, PathGeometry, Tool } from './types'
import { uuid } from '../uuid'

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
  lockedLayerIds: Set<string>
  tool: Tool
  readOnly: boolean
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  commit: (change: Change) => void
  /** Template for new markups: document, page, layer and current style. */
  newBase: { document_id: string; page: number; layer_id: string | null; style: MarkupStyle; stampText: string }
  /** Set true when the markup layer owns the current pointer (so the viewport doesn't pan). */
  consumedRef: React.MutableRefObject<boolean>
  onCreated?: (m: Markup) => void
}

const TWO_POINT: MarkupType[] = ['line', 'arrow']
const DRAG_TOOLS: MarkupType[] = ['line', 'arrow', 'rect', 'ellipse', 'cloud', 'highlight', 'text', 'freehand']

export const MarkupCanvas = forwardRef<MarkupCanvasHandle, Props>(function MarkupCanvas(props, ref) {
  const { width, height, zoom, markups, lockedLayerIds, tool, readOnly, selectedIds, onSelect, commit, newBase, consumedRef, onCreated } = props
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const [draft, setDraft] = useState<Markup | null>(null)
  const dragStart = useRef<Pt | null>(null)
  const freehandPts = useRef<Pt[]>([])
  const clickPts = useRef<Pt[]>([])
  const [pointOverride, setPointOverride] = useState<{ id: string; points: number[] } | null>(null)

  const byId = new Map(markups.map(m => [m.id, m]))
  const selected = selectedIds.map(id => byId.get(id)).filter((m): m is Markup => !!m)
  const single = selected.length === 1 ? selected[0] : null
  const isDrawTool = tool !== 'select' && tool !== 'pan' && !readOnly

  // Attach transformer to selected nodes (2-point lines use point handles instead)
  useEffect(() => {
    const tr = trRef.current, stage = stageRef.current
    if (!tr || !stage) return
    const nodes = readOnly || tool !== 'select' ? [] : selected
      .filter(m => !(selected.length === 1 && TWO_POINT.includes(m.type)))
      .map(m => stage.findOne<Konva.Group>('#' + m.id))
      .filter((n): n is Konva.Group => !!n)
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  })

  const pointer = (): Pt => stageRef.current!.getRelativePointerPosition() ?? { x: 0, y: 0 }

  const newMarkup = (type: MarkupType, geometry: BoxGeometry | PathGeometry): Markup => ({
    id: uuid(), document_id: newBase.document_id, page: newBase.page, type, geometry,
    style: { ...newBase.style }, text: type === 'stamp' ? newBase.stampText : '', layer_id: newBase.layer_id,
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
    if (!draft || (draft.type !== 'polyline' && draft.type !== 'polygon')) return
    // Drop the rubber-band point and any double-click duplicate
    const pts = clickPts.current.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.5)
    const min = draft.type === 'polygon' ? 3 : 2
    finish(pts.length >= min ? newMarkup(draft.type, pathFromPoints(pts)) : null)
  }

  useImperativeHandle(ref, () => ({
    stage: () => stageRef.current,
    cancelDraft: () => finish(null),
    finishDraft: finishClickPath,
  }))

  // Leaving a tool abandons its half-drawn markup
  useEffect(() => { finish(null) }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps

  const markupIdOf = (node: Konva.Node | null): string | null => {
    while (node && node !== stageRef.current) {
      if (node.name() === 'markup') return node.id()
      node = node.getParent()
    }
    return null
  }

  function onPointerDown(e: Konva.KonvaEventObject<PointerEvent>) {
    if (e.evt.button !== 0) return
    const target = e.target
    const onTransformer = target.getParent()?.getClassName?.() === 'Transformer'
    const hitId = markupIdOf(target)

    if (!isDrawTool) {
      if (tool === 'pan') { consumedRef.current = false; return }
      if (onTransformer || target.name() === 'point-handle') { consumedRef.current = true; return }
      if (hitId) {
        consumedRef.current = true
        if (e.evt.shiftKey) onSelect(selectedIds.includes(hitId) ? selectedIds.filter(i => i !== hitId) : [...selectedIds, hitId])
        else if (!selectedIds.includes(hitId)) onSelect([hitId])
      } else {
        consumedRef.current = false // empty space: pan
        if (!e.evt.shiftKey) onSelect([])
      }
      return
    }

    consumedRef.current = true
    const p = pointer()
    const t = tool as MarkupType
    if (t === 'stamp') {
      finish(newMarkup('stamp', { x: p.x - 80, y: p.y - 25, width: 160, height: 50, rotation: 0 }))
      return
    }
    if (t === 'polyline' || t === 'polygon') {
      const pts = clickPts.current
      if (!pts.length) {
        clickPts.current = [p, p]
      } else {
        const first = pts[0]
        if (t === 'polygon' && pts.length >= 4 && Math.hypot(p.x - first.x, p.y - first.y) < 10 / zoom) {
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
      setDraft(newMarkup(t, isBoxType(t) ? boxFromDrag(p, p) : pathFromPoints([p, p])))
    }
  }

  function onPointerMove(e: Konva.KonvaEventObject<PointerEvent>) {
    if (!draft) return
    const p = pointer()
    const shift = e.evt.shiftKey
    if (draft.type === 'polyline' || draft.type === 'polygon') {
      const pts = clickPts.current
      const last = shift && pts.length > 1 ? snap45(pts[pts.length - 2], p) : p
      clickPts.current = [...pts.slice(0, -1), last]
      setDraft({ ...draft, geometry: pathFromPoints(clickPts.current) })
      return
    }
    const a = dragStart.current
    if (!a) return
    if (draft.type === 'freehand') {
      freehandPts.current.push(p)
      setDraft({ ...draft, geometry: pathFromPoints(freehandPts.current) })
    } else if (isBoxType(draft.type)) {
      setDraft({ ...draft, geometry: boxFromDrag(a, p, shift) })
    } else {
      setDraft({ ...draft, geometry: pathFromPoints([a, shift ? snap45(a, p) : p]) })
    }
  }

  function onPointerUp() {
    if (!draft || !dragStart.current) return
    const g = draft.geometry
    const tiny = 4 / zoom
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
        : bakeBox({ ...base, width: m.geometry.width, height: m.geometry.height }, sx, sy)
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
    // Transformer drags every attached node together; save them all
    const ids = selectedIds.includes(id) ? selectedIds : [id]
    const change: Change = []
    for (const mid of ids) {
      const m = byId.get(mid)
      const node = stage.findOne<Konva.Group>('#' + mid)
      if (!m || !node) continue
      if (node.x() === m.geometry.x && node.y() === m.geometry.y) continue
      change.push({ before: m, after: { ...m, geometry: { ...m.geometry, x: node.x(), y: node.y() } } })
    }
    commit(change)
    if (!selectedIds.includes(id)) onSelect([id])
  }

  // Konva reports two quick clicks anywhere as a double-click; only finish when both
  // clicks land on the same spot, so fast point placement isn't cut short.
  function onDoubleClick() {
    const pts = clickPts.current
    if (pts.length < 3) return
    const a = pts[pts.length - 3], b = pts[pts.length - 2]
    if (Math.hypot(a.x - b.x, a.y - b.y) < 8 / zoom) finishClickPath()
  }

  const canDrag = (m: Markup) => tool === 'select' && !readOnly && !lockedLayerIds.has(m.layer_id ?? '')

  return (
    <Stage ref={stageRef} width={width} height={height} className="markup-stage"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onDblClick={onDoubleClick} onDblTap={onDoubleClick}>
      <Layer>
        {markups.map(m => {
          const shown = pointOverride?.id === m.id && 'points' in m.geometry
            ? { ...m, geometry: { ...m.geometry, points: pointOverride.points } } : m
          const editable = single?.id === m.id && !readOnly && tool === 'select'
            && 'points' in m.geometry && m.type !== 'freehand' && !lockedLayerIds.has(m.layer_id ?? '')
          return (
            <MarkupShape key={m.id} markup={shown} zoom={zoom}
              draggable={canDrag(m)}
              listening={!lockedLayerIds.has(m.layer_id ?? '') && !isDrawTool}
              editPoints={editable}
              onPointsChange={(points, done) => {
                if (!done) { setPointOverride({ id: m.id, points }); return }
                setPointOverride(null)
                commit([{ before: m, after: { ...m, geometry: { ...(m.geometry as PathGeometry), points } } }])
              }}
              onDragEnd={onDragEnd} />
          )
        })}
        {draft && <MarkupShape markup={draft} zoom={zoom} listening={false} />}
        <Transformer ref={trRef} rotateEnabled keepRatio={false} ignoreStroke flipEnabled={false}
          rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]} rotationSnapTolerance={4}
          anchorSize={11} anchorCornerRadius={2} borderStroke="#1971c2" anchorStroke="#1971c2"
          boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
          onTransformEnd={onTransformEnd} />
      </Layer>
    </Stage>
  )
})
