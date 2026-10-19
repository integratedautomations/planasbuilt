import { useCallback, useEffect, useRef, useState } from 'react'
import { Arrow, Image as KImage, Layer, Line, Rect, Stage, Text } from 'react-konva'
import { queuePhotoAnnotated } from '../offline/sync'
import './photos.css'

type Kind = 'pen' | 'arrow' | 'rect' | 'text'
interface Shape { kind: Kind; color: string; width: number; points: number[]; text?: string }
interface View { scale: number; x: number; y: number }

const COLORS = [['Red', '#e03131'], ['Yellow', '#ffd43b'], ['White', '#ffffff'], ['Blue', '#1c7ed6']]
const WIDTHS = [['Thin', 3], ['Medium', 6], ['Thick', 12]] as const
const TOOLS: [Kind, string][] = [['pen', 'Pen'], ['arrow', 'Arrow'], ['rect', 'Box'], ['text', 'Text']]

interface Props { attachmentId: string; /** URL of the unannotated original (server or local blob) */ src: string; onClose: () => void; onSaved: () => void }

export function PhotoAnnotator({ attachmentId, src, onClose, onSaved }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [shapes, setShapes] = useState<Shape[]>([])
  const [redo, setRedo] = useState<Shape[]>([])
  const [draft, setDraft] = useState<Shape | null>(null)
  const [tool, setTool] = useState<Kind>('pen')
  const [color, setColor] = useState(COLORS[0][1] as string)
  const [wIdx, setWIdx] = useState(1)
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null)
  const [textVal, setTextVal] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const draftRef = useRef<Shape | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; cx: number; cy: number; view: View } | null>(null)
  const viewRef = useRef(view); viewRef.current = view
  const fit = useRef(1)

  // The unannotated original is always the base, so re-annotating never stacks on old marks.
  useEffect(() => {
    const i = new window.Image()
    i.onload = () => setImg(i)
    i.onerror = () => setLoadErr('Could not load the photo.')
    i.src = src
  }, [src])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fitView = useCallback(() => {
    if (!img || !size.w || !size.h) return
    const s = Math.min(size.w / img.naturalWidth, size.h / img.naturalHeight)
    fit.current = s
    setView({ scale: s, x: (size.w - img.naturalWidth * s) / 2, y: (size.h - img.naturalHeight * s) / 2 })
  }, [img, size.w, size.h])
  useEffect(fitView, [fitView])

  // Stroke sizes scale with image resolution so marks look the same on any photo.
  const k = img ? Math.max(img.naturalWidth, img.naturalHeight) / 1000 : 1
  const strokeW = WIDTHS[wIdx][1] * k

  const toImage = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (cx - r.left - v.x) / v.scale, y: (cy - r.top - v.y) / v.scale }
  }
  const setDraftBoth = (s: Shape | null) => { draftRef.current = s; setDraft(s) }

  const onDown = (e: React.PointerEvent) => {
    if (!img || textAt) return
    box.current!.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      setDraftBoth(null)
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: viewRef.current }
      return
    }
    if (pointers.current.size > 2) return
    const p = toImage(e.clientX, e.clientY)
    if (tool === 'text') { setTextAt(p); setTextVal(''); return }
    setDraftBoth({ kind: tool, color, width: strokeW, points: tool === 'pen' ? [p.x, p.y] : [p.x, p.y, p.x, p.y] })
  }

  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const p0 = pinch.current
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
      const scale = Math.min(Math.max(p0.view.scale * dist / p0.dist, fit.current * 0.8), fit.current * 12)
      const r = box.current!.getBoundingClientRect()
      // Keep the image point that was under the initial pinch center under the current center.
      const ix = (p0.cx - r.left - p0.view.x) / p0.view.scale
      const iy = (p0.cy - r.top - p0.view.y) / p0.view.scale
      setView({ scale, x: cx - r.left - ix * scale, y: cy - r.top - iy * scale })
      return
    }
    const d = draftRef.current
    if (!d) return
    const p = toImage(e.clientX, e.clientY)
    setDraftBoth(d.kind === 'pen'
      ? { ...d, points: [...d.points, p.x, p.y] }
      : { ...d, points: [d.points[0], d.points[1], p.x, p.y] })
  }

  const onUp = (e: React.PointerEvent) => {
    const had = pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (!had) return
    const d = draftRef.current
    if (d && pointers.current.size === 0) {
      const tiny = d.kind !== 'pen' && Math.hypot(d.points[2] - d.points[0], d.points[3] - d.points[1]) < 4 * k
      if (!tiny) { setShapes(s => [...s, d]); setRedo([]) }
      setDraftBoth(null)
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect()
    const v = viewRef.current
    const scale = Math.min(Math.max(v.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), fit.current * 0.8), fit.current * 12)
    const ix = (e.clientX - r.left - v.x) / v.scale, iy = (e.clientY - r.top - v.y) / v.scale
    setView({ scale, x: e.clientX - r.left - ix * scale, y: e.clientY - r.top - iy * scale })
  }

  const commitText = () => {
    if (textAt && textVal.trim()) {
      setShapes(s => [...s, { kind: 'text', color, width: 28 * k * (WIDTHS[wIdx][1] / 6), points: [textAt.x, textAt.y], text: textVal.trim() }])
      setRedo([])
    }
    setTextAt(null)
  }

  const undo = () => setShapes(s => { if (!s.length) return s; setRedo(r => [...r, s[s.length - 1]]); return s.slice(0, -1) })
  const redoFn = () => setRedo(r => { if (!r.length) return r; setShapes(s => [...s, r[r.length - 1]]); return r.slice(0, -1) })

  const save = async () => {
    if (!img) return
    setSaving(true); setErr('')
    try {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.textBaseline = 'top'
      for (const s of shapes) drawShape(ctx, s)
      const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Export failed')), 'image/jpeg', 0.9))
      await queuePhotoAnnotated(attachmentId, blob)
      onSaved()
    } catch (e) {
      setErr((e as Error).message || 'Save failed')
      setSaving(false)
    }
  }

  const all = draft ? [...shapes, draft] : shapes

  return (
    <div className="photo-modal" role="dialog" aria-label="Annotate photo">
      <div className="pm-bar">
        {TOOLS.map(([t, label]) => <button key={t} className={tool === t ? 'on' : ''} onClick={() => setTool(t)}>{label}</button>)}
        <span className="grow" />
        <button onClick={undo} disabled={!shapes.length} aria-label="Undo">Undo</button>
        <button onClick={redoFn} disabled={!redo.length} aria-label="Redo">Redo</button>
        <button onClick={fitView} aria-label="Fit to screen">Fit</button>
      </div>
      <div className="pm-bar">
        {COLORS.map(([name, c]) => (
          <button key={c} className={'pm-swatch' + (color === c ? ' on' : '')} style={{ background: c }}
            aria-label={name} onClick={() => setColor(c)} />
        ))}
        <span className="grow" />
        {WIDTHS.map(([name], i) => <button key={name} className={wIdx === i ? 'on' : ''} onClick={() => setWIdx(i)}>{name}</button>)}
      </div>
      <div ref={box} className="pm-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
        {loadErr && <div className="pm-msg">{loadErr}</div>}
        {img && size.w > 0 && (
          <Stage width={size.w} height={size.h} x={view.x} y={view.y} scaleX={view.scale} scaleY={view.scale} listening={false}>
            <Layer listening={false}>
              <KImage image={img} width={img.naturalWidth} height={img.naturalHeight} />
              {all.map((s, i) => renderShape(s, i))}
            </Layer>
          </Stage>
        )}
        {textAt && (
          <div className="pm-caption" style={{ position: 'absolute', left: 0, right: 0, top: 0 }} onPointerDown={e => e.stopPropagation()}>
            <input autoFocus value={textVal} placeholder="Label text" onChange={e => setTextVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitText() }} />
            <button onClick={commitText}>Add</button>
            <button onClick={() => setTextAt(null)}>Cancel</button>
          </div>
        )}
      </div>
      <div className="pm-bar">
        {err && <span className="grow" style={{ color: '#ff8787' }}>{err}</span>}
        {!err && <span className="grow" />}
        <button onClick={onClose} disabled={saving}>Cancel</button>
        <button className="on" onClick={save} disabled={saving || !img}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

function renderShape(s: Shape, i: number) {
  const common = { key: i, stroke: s.color, strokeWidth: s.width, listening: false, lineCap: 'round' as const, lineJoin: 'round' as const }
  const [x0, y0, x1, y1] = s.points
  if (s.kind === 'pen') return <Line {...common} points={s.points} tension={0.3} />
  if (s.kind === 'arrow') return <Arrow {...common} points={s.points} fill={s.color} pointerLength={s.width * 4} pointerWidth={s.width * 4} />
  if (s.kind === 'rect') return <Rect {...common} x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} />
  return <Text key={i} x={x0} y={y0} text={s.text} fontSize={s.width} fontStyle="bold" fill={s.color} stroke="#000" strokeWidth={s.width / 7} fillAfterStrokeEnabled listening={false} />
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width
  const [x0, y0, x1, y1] = s.points
  if (s.kind === 'pen') {
    ctx.beginPath()
    ctx.moveTo(s.points[0], s.points[1])
    for (let i = 2; i < s.points.length; i += 2) ctx.lineTo(s.points[i], s.points[i + 1])
    if (s.points.length === 2) ctx.lineTo(x0 + 0.01, y0)
    ctx.stroke()
  } else if (s.kind === 'rect') {
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
  } else if (s.kind === 'arrow') {
    const len = s.width * 4, a = Math.atan2(y1 - y0, x1 - x0)
    const bx = x1 - Math.cos(a) * len * 0.8, by = y1 - Math.sin(a) * len * 0.8
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(bx, by); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 - len * Math.cos(a - Math.PI / 7), y1 - len * Math.sin(a - Math.PI / 7))
    ctx.lineTo(x1 - len * Math.cos(a + Math.PI / 7), y1 - len * Math.sin(a + Math.PI / 7))
    ctx.closePath(); ctx.fill()
  } else if (s.text) {
    ctx.font = `bold ${s.width}px system-ui, sans-serif`
    ctx.lineWidth = s.width / 7; ctx.strokeStyle = '#000'
    ctx.strokeText(s.text, x0, y0); ctx.fillText(s.text, x0, y0)
  }
}
