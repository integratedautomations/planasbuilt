import { Component, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Arrow, Circle, Ellipse, Group, Image as KImage, Line, Rect, Shape, Text, Wedge } from 'react-konva'
import type Konva from 'konva'
import { FONT_MONO, FONT_UI } from './canvasFonts'
import { cloudArcs, deviceCenter } from './geometry'
import { feetOf, formatArea, formatFeetInches, formatRadius, pathMidpoint, polygonCentroid, polygonPerimeter, radiusOf, sqftOf } from './measure'
import { STATUSES } from './types'
import { clampAngle, COVERAGE_OPACITY, formatRange, hasCoverage, normDeg, rangeFeet, rangePx, withRangePx } from './coverage'
import type { BoxGeometry, Fov, Markup, PathGeometry, Status, SymbolSet } from './types'
import { useImage } from './useImage'
import { legendLayout, legendSettings } from './legend'
import type { LegendRow } from './legend'

interface Props {
  markup: Markup
  zoom: number
  /** points_per_foot for this markup's page (null = not calibrated). */
  scale?: number | null
  /** 1-based number shown on a count marker. */
  countNumber?: number
  symbolSet?: SymbolSet
  /** Icon image for a device: its device type's icon, else the set's (default). */
  iconSrc?: string
  /** Names from the outermost area down to this area (area markups only). */
  areaPath?: string[]
  draggable?: boolean
  listening?: boolean
  /** Show per-point handles (single selected path markup). */
  editPoints?: boolean
  onPointsChange?: (points: number[], done: boolean) => void
  /** Show the coverage-cone handle (single selected camera). */
  editFov?: boolean
  /** Global "Show coverage cones" switch (default true). */
  showCones?: boolean
  onFovChange?: (fov: Fov, done: boolean) => void
  onDragStart?: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDragEnd?: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDblClick?: () => void
  /** Set on the drawn (top) member of a device stack. */
  stack?: StackView
  /** A non-top stack member: keeps its node (for selection, drag, resize) but draws no icon. */
  ghost?: boolean
  /** Rows of a legend markup (computed by the viewer from all markups). */
  legendRows?: LegendRow[]
}

export interface StackView { count: number; label: string; statuses: Status[] }

/**
 * Every markup is a Group positioned at geometry x/y/rotation. Boxes draw children at
 * 0..width Ã— 0..height; paths draw their relative points. The Transformer scales the
 * Group, and the scale is baked back into geometry on transform end.
 * A device's coverage cone is a sibling (outside the Group) so resizing the
 * icon doesn't stretch the cone.
 */
function MarkupShapeInner(props: Props) {
  const { markup: m, zoom, scale = null, countNumber, symbolSet, iconSrc, areaPath, draggable, listening = true, editPoints, onPointsChange, editFov, onFovChange, onDragStart, onDragEnd, onDblClick, showCones = true, stack, ghost, legendRows } = props
  const g = m.geometry
  const fovRef = useRef<Konva.Group>(null)
  const fov = m.type === 'device' && 'width' in g && showCones && hasCoverage(g.fov) ? g.fov : undefined

  // Keep the cone attached while the device is being dragged
  const onDragMove = (e: Konva.KonvaEventObject<DragEvent>) => {
    if (!fovRef.current || !('width' in g) || e.target.name() !== 'markup') return
    const c = deviceCenter({ ...g, x: e.target.x(), y: e.target.y() })
    fovRef.current.position(c)
  }

  return (
    <>
      {fov && 'width' in g && (
        <FovCone innerRef={fovRef} center={deviceCenter(g)} fov={fov} color={symbolSet?.color ?? '#868e96'} zoom={zoom} ppf={scale}
          editable={!!editFov && !fov.locked} onChange={onFovChange} />
      )}
      <Group id={m.id} name="markup" x={g.x} y={g.y} rotation={g.rotation}
        draggable={draggable} listening={listening && !ghost} opacity={m.style.opacity}
        onDragMove={fov ? onDragMove : undefined}
        onDragStart={onDragStart} onDragEnd={onDragEnd} onDblClick={onDblClick} onDblTap={onDblClick}>
        {'points' in g ? <PathBody m={m} g={g} zoom={zoom} scale={scale} countNumber={countNumber} areaPath={areaPath} />
          : m.type === 'device' ? (ghost ? <Rect width={g.width} height={g.height} fill="transparent" listening={false} />
            : <DeviceBody m={m} g={g} set={symbolSet} iconSrc={iconSrc} zoom={zoom} stack={stack} />)
          : m.type === 'legend' ? <LegendBody m={m} g={g} rows={legendRows ?? []} />
          : <BoxBody m={m} g={g} />}
        {editPoints && 'points' in g && onPointsChange && (
          <PointHandles points={g.points} zoom={zoom} onChange={onPointsChange} />
        )}
      </Group>
    </>
  )
}

/**
 * One malformed markup (bad data from a PDF import or the server) must not blank the whole viewer:
 * a render error draws nothing for that markup. A changed markup object gets another try.
 */
interface BoundaryState { hasError: boolean; failedFor?: Markup }
class ShapeBoundary extends Component<{ markup?: Markup; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { hasError: false }
  static getDerivedStateFromError(): Partial<BoundaryState> { return { hasError: true } }
  static getDerivedStateFromProps(props: { markup?: Markup }, state: BoundaryState): Partial<BoundaryState> | null {
    return state.hasError && state.failedFor && props.markup !== state.failedFor ? { hasError: false, failedFor: undefined } : null
  }
  componentDidCatch(err: unknown) {
    console.error('markup render failed', this.props.markup?.id, err)
    this.setState({ failedFor: this.props.markup })
  }
  render() { return this.state.hasError ? null : this.props.children }
}

export function MarkupShape(props: Props) {
  return <ShapeBoundary markup={props.markup}><MarkupShapeInner {...props} /></ShapeBoundary>
}

function DeviceBody({ m, g, set, iconSrc, zoom, stack }: { m: Markup; g: BoxGeometry; set?: SymbolSet; iconSrc?: string; zoom: number; stack?: StackView }) {
  const icon = useImage(iconSrc ?? set?.icon)
  const color = set?.color ?? '#868e96'
  const r = Math.min(g.width, g.height) / 2
  const cx = g.width / 2, cy = g.height / 2
  const statuses = stack ? stack.statuses : [m.status ?? '']
  const distinct = [...new Set(statuses)]
  const mixed = distinct.length > 1
  const status = mixed ? undefined : STATUSES.find(s => s.value === distinct[0])
  const fontSize = Math.max(4, r * 0.7)
  const label = (stack ? stack.label : m.tag) || set?.tag_prefix || '?'
  const bx = cx + r * 0.75, by = cy - r * 0.75, br = r * 0.3
  const mixColors = distinct.map(v => STATUSES.find(s => s.value === v)?.color ?? '#adb5bd')
  // Quantity pill: sized in screen pixels so it stays readable at any zoom
  const qfs = Math.max(r * 0.6, 11 / zoom)
  const qtext = stack ? `\u00d7${stack.count}` : ''
  const qw = qfs * (0.62 * qtext.length + 0.9), qh = qfs * 1.45
  const qx = cx + r * 0.8, qy = cy + r * 0.8
  return (
    <>
      <Circle x={cx} y={cy} radius={r} fill={color} stroke="#fff" strokeWidth={r * 0.12} />
      {icon && <KImage image={icon} x={cx - r * 0.62} y={cy - r * 0.62} width={r * 1.24} height={r * 1.24} />}
      {status && <Circle x={bx} y={by} radius={br} fill={status.color} stroke="#fff" strokeWidth={r * 0.08} />}
      {mixed && (
        <>
          <Wedge x={bx} y={by} radius={br} angle={180} rotation={90} fill={mixColors[0]} />
          <Wedge x={bx} y={by} radius={br} angle={180} rotation={-90} fill={mixColors[1]} />
          <Circle x={bx} y={by} radius={br} stroke="#fff" strokeWidth={r * 0.08} />
        </>
      )}
      <Text text={label} x={cx - 100} y={cy + r + r * 0.12} width={200} align="center"
        fontSize={fontSize} fontStyle="bold" fill={color} stroke="#fff" strokeWidth={fontSize * 0.18}
        fillAfterStrokeEnabled fontFamily={FONT_MONO} listening={false} />
      {stack && (
        <>
          <Rect x={qx - qw / 2} y={qy - qh / 2} width={qw} height={qh} cornerRadius={qh / 2} fill={color}
            stroke="#fff" strokeWidth={qfs * 0.12} listening={false} />
          <Text text={qtext} x={qx - qw / 2} y={qy - qh / 2} width={qw} height={qh} align="center" verticalAlign="middle"
            fontSize={qfs} fontStyle="bold" fill="#fff" fontFamily={FONT_MONO} listening={false} />
        </>
      )}
    </>
  )
}

function LegendIcon({ src, color, size }: { src: string; color: string; size: number }) {
  const img = useImage(src || undefined)
  return img
    ? <KImage image={img} width={size} height={size} />
    : <Circle x={size / 2} y={size / 2} radius={size * 0.38} fill={color} />
}

/** Count legend: title, then one row per device type/product with icon, name, code and count. Height follows the rows. */
function LegendBody({ m, g, rows }: { m: Markup; g: BoxGeometry; rows: LegendRow[] }) {
  const s = legendSettings(m)
  const fs = m.style.fontSize || 12
  const L = legendLayout(rows, s, g.width, fs)
  const ink = m.style.stroke || '#343a40'
  const font = FONT_UI
  let x = L.pad
  const colX: Record<string, number> = {}
  for (const c of s.columns) { colX[c] = x; x += L.widths[c] }
  return (
    <>
      <Rect width={g.width} height={L.height} fill={m.style.fill || '#fff'} stroke={ink} strokeWidth={m.style.strokeWidth || 1} />
      {s.title.trim() && (
        <Text text={s.title} x={L.pad} y={L.pad * 0.8} width={g.width - L.pad * 2} height={L.titleH} fontSize={fs * 1.2} fontStyle="bold" fill={ink} fontFamily={font} listening={false} />
      )}
      {rows.length === 0 && (
        <Text text="No devices" x={L.pad} y={L.titleH + L.pad} fontSize={fs} fill="#868e96" fontFamily={font} listening={false} />
      )}
      {rows.map((r, i) => {
        const y = L.titleH + L.pad + i * L.rowH
        return (
          <Group key={r.key} y={y} listening={false}>
            {s.columns.includes('icon') && <Group x={colX.icon + L.rowH * 0.1}><LegendIcon src={r.icon} color={r.color} size={L.rowH * 0.8} /></Group>}
            {s.columns.includes('name') && <Text text={r.name} x={colX.name} width={L.widths.name - 4} height={L.rowH} verticalAlign="middle" wrap="none" ellipsis fontSize={fs} fill={ink} fontFamily={font} />}
            {s.columns.includes('code') && <Text text={r.code} x={colX.code} width={L.widths.code - 4} height={L.rowH} verticalAlign="middle" wrap="none" ellipsis fontSize={fs} fill="#495057" fontFamily={FONT_MONO} />}
            {s.columns.includes('count') && <Text text={String(r.count)} x={colX.count} width={L.widths.count - 4} height={L.rowH} align="right" verticalAlign="middle" fontSize={fs} fontStyle="bold" fill={ink} fontFamily={FONT_MONO} />}
          </Group>
        )
      })}
      <Rect width={g.width} height={L.height} fill="transparent" />
    </>
  )
}

function FovCone({ innerRef, center, fov, color, zoom, ppf, editable, onChange }: {
  innerRef: React.RefObject<Konva.Group | null>; center: { x: number; y: number }; fov: Fov; color: string
  zoom: number; ppf: number | null; editable: boolean; onChange?: (f: Fov, done: boolean) => void
}) {
  const range = rangePx(fov, ppf)
  const rad = (fov.direction * Math.PI) / 180
  const tip = { x: Math.cos(rad) * range, y: Math.sin(rad) * range }
  const edgeRad = ((fov.direction + fov.angle / 2) * Math.PI) / 180
  const edge = { x: Math.cos(edgeRad) * range, y: Math.sin(edgeRad) * range }
  const [dragging, setDragging] = useState(false)
  const dragTip = (e: Konva.KonvaEventObject<DragEvent>, done: boolean) => {
    e.cancelBubble = true
    setDragging(!done)
    const x = e.target.x(), y = e.target.y()
    onChange?.({ ...withRangePx(fov, Math.hypot(x, y), ppf), direction: normDeg((Math.atan2(y, x) * 180) / Math.PI) }, done)
  }
  const dragEdge = (e: Konva.KonvaEventObject<DragEvent>, done: boolean) => {
    e.cancelBubble = true
    setDragging(!done)
    const x = e.target.x(), y = e.target.y()
    let diff = Math.abs(normDeg((Math.atan2(y, x) * 180) / Math.PI - fov.direction))
    if (diff === 0 && fov.angle >= 360) diff = 180
    onChange?.({ ...fov, angle: clampAngle(diff * 2) }, done)
  }
  const ft = rangeFeet(fov, ppf)
  const label = `${ft !== null ? formatRange(ft) : `${Math.round(range)} pt`} · ${Math.round(fov.angle)}°`
  const hr = 7 / zoom, fs = 12 / zoom
  return (
    <Group ref={innerRef} x={center.x} y={center.y} listening={editable}>
      <Wedge radius={range} angle={Math.min(360, fov.angle)} rotation={fov.direction - Math.min(360, fov.angle) / 2}
        fill={color} opacity={fov.opacity ?? COVERAGE_OPACITY} listening={false} />
      <Wedge radius={range} angle={Math.min(360, fov.angle)} rotation={fov.direction - Math.min(360, fov.angle) / 2}
        stroke={color} strokeWidth={1.5 / zoom} listening={false} />
      {editable && (
        <>
          <Circle name="point-handle" x={tip.x} y={tip.y} radius={hr} fill="#fff" stroke={color}
            strokeWidth={2 / zoom} draggable onDragStart={e => { e.cancelBubble = true }}
            onDragMove={e => dragTip(e, false)} onDragEnd={e => dragTip(e, true)} />
          <Circle name="point-handle" x={edge.x} y={edge.y} radius={hr * 0.8} fill={color} stroke="#fff"
            strokeWidth={1.5 / zoom} draggable onDragStart={e => { e.cancelBubble = true }}
            onDragMove={e => dragEdge(e, false)} onDragEnd={e => dragEdge(e, true)} />
          {dragging && (
            <Text text={label} x={tip.x + hr * 1.5} y={tip.y - fs / 2} fontSize={fs} fontStyle="bold" fill={color}
              stroke="#fff" strokeWidth={fs * 0.25} fillAfterStrokeEnabled fontFamily={FONT_MONO} listening={false} />
          )}
        </>
      )}
    </Group>
  )
}

function BoxBody({ m, g }: { m: Markup; g: BoxGeometry }) {
  const { stroke, fill, strokeWidth, dash } = m.style
  const common = {
    stroke: stroke || undefined, strokeWidth: stroke ? strokeWidth : 0,
    fill: fill || undefined, dash: dash ? [strokeWidth * 4, strokeWidth * 3] : undefined,
  }
  // Transparent full-box hit area so unfilled shapes are selectable by clicking inside
  const hit = <Rect width={g.width} height={g.height} fill="transparent" />
  switch (m.type) {
    case 'rect':
      return <><Rect width={g.width} height={g.height} {...common} />{hit}</>
    case 'ellipse':
      return <><Ellipse x={g.width / 2} y={g.height / 2} radiusX={g.width / 2} radiusY={g.height / 2} {...common} />{hit}</>
    case 'highlight':
      return <Rect width={g.width} height={g.height} fill={fill || '#ffd43b'} globalCompositeOperation="multiply" />
    case 'cloud': {
      const size = Math.max(8, Math.min(24, Math.min(g.width, g.height) / 3))
      return (
        <>
          <Shape {...common} sceneFunc={(ctx, shape) => {
            ctx.beginPath()
            for (const a of cloudArcs(g.width, g.height, size)) ctx.arc(a.cx, a.cy, a.r, a.start, a.end, false)
            ctx.closePath()
            ctx.fillStrokeShape(shape)
          }} />
          {hit}
        </>
      )
    }
    case 'text':
      return (
        <>
          <Rect width={g.width} height={g.height} fill={fill || 'transparent'}
            stroke={stroke || undefined} strokeWidth={stroke ? Math.max(1, strokeWidth / 2) : 0} />
          <Text width={g.width} height={g.height} padding={6} text={m.text || 'Text'}
            fontSize={m.style.fontSize} fill={stroke || '#000'} fontFamily={FONT_UI} />
        </>
      )
    case 'stamp': {
      const label = (m.text || 'STAMP').toUpperCase()
      const fontSize = Math.max(6, Math.min(g.height * 0.55, (g.width - 16) / (label.length * 0.62)))
      return (
        <>
          <Rect width={g.width} height={g.height} cornerRadius={Math.min(g.height / 4, 10)}
            stroke={stroke || '#e03131'} strokeWidth={Math.max(2, strokeWidth)} fill={fill || 'transparent'} />
          <Text width={g.width} height={g.height} text={label} align="center" verticalAlign="middle"
            fontSize={fontSize} fontStyle="bold" fill={stroke || '#e03131'} fontFamily={FONT_UI} />
        </>
      )
    }
    default:
      return null
  }
}

/** Value label centered on a point, with a white halo, sized to stay readable on screen. */
function MeasureLabel({ at, text, zoom, fontSize, color, warn }: {
  at: { x: number; y: number }; text: string; zoom: number; fontSize: number; color: string; warn?: boolean
}) {
  const fs = Math.min(80, Math.max(6, (fontSize * 0.7) / zoom))
  const lines = text.split('\n').length
  return (
    <Text text={text} x={at.x - 150} y={at.y - (fs * 1.2 * lines) / 2} width={300} align="center" lineHeight={1.2}
      fontSize={fs} fontStyle="bold" fill={warn ? '#c92a2a' : color} stroke="#fff" strokeWidth={fs * 0.28}
      fillAfterStrokeEnabled fontFamily={FONT_MONO} listening={false} />
  )
}

function hexAlpha(hex: string, a: number) {
  const h = hex.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(h)) return hex
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}

function PathBody({ m, g, zoom, scale, countNumber, areaPath }: { m: Markup; g: PathGeometry; zoom: number; scale: number | null; countNumber?: number; areaPath?: string[] }) {
  const { stroke, fill, strokeWidth, dash } = m.style
  const common = {
    points: g.points, stroke: stroke || '#e03131', strokeWidth,
    dash: dash ? [strokeWidth * 4, strokeWidth * 3] : undefined,
    hitStrokeWidth: Math.max(strokeWidth, 12 / zoom),
    lineCap: 'round' as const, lineJoin: 'round' as const,
  }
  switch (m.type) {
    case 'area':
      return <AreaBody m={m} g={g} zoom={zoom} path={areaPath} />
    case 'arrow':
      return <Arrow {...common} fill={stroke || '#e03131'} pointerLength={strokeWidth * 4 + 6} pointerWidth={strokeWidth * 3 + 6} />
    case 'polygon':
      return <Line {...common} closed fill={fill || 'transparent'} />
    case 'freehand':
      return <Line {...common} tension={0.4} />
    case 'measure-length': {
      const [x0, y0, x1, y1] = g.points
      const len = Math.hypot(x1 - x0, y1 - y0) || 1
      const t = Math.max(strokeWidth * 2.5, 7 / zoom)
      const nx = (-(y1 - y0) / len) * t, ny = ((x1 - x0) / len) * t
      const mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
      return (
        <>
          <Line {...common} points={[x0, y0, x1, y1]} />
          <Line points={[x0 - nx, y0 - ny, x0 + nx, y0 + ny]} stroke={stroke || '#e03131'} strokeWidth={strokeWidth} listening={false} />
          <Line points={[x1 - nx, y1 - ny, x1 + nx, y1 + ny]} stroke={stroke || '#e03131'} strokeWidth={strokeWidth} listening={false} />
          <MeasureLabel at={mid} zoom={zoom} fontSize={m.style.fontSize} color={stroke || '#e03131'} warn={!scale}
            text={scale ? formatFeetInches(feetOf(g.points, scale)) : 'Set scale'} />
        </>
      )
    }
    case 'measure-radius': {
      const [x0, y0, x1, y1] = g.points
      const r = radiusOf(g.points)
      const col = stroke || '#e03131'
      return (
        <>
          <Circle x={x0} y={y0} radius={r} stroke={col} strokeWidth={strokeWidth} dash={common.dash} fill={hexAlpha(fill || col, fill ? 0.22 : 0.08)} hitStrokeWidth={common.hitStrokeWidth} />
          <Line {...common} points={[x0, y0, x1, y1]} />
          <Circle x={x0} y={y0} radius={Math.max(strokeWidth * 1.2, 2.5 / zoom)} fill={col} listening={false} />
          <MeasureLabel at={{ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }} zoom={zoom} fontSize={m.style.fontSize} color={col} warn={!scale}
            text={scale ? formatRadius(r / scale) : 'Set scale'} />
        </>
      )
    }
    case 'measure-polylength':
      return (
        <>
          <Line {...common} />
          <MeasureLabel at={pathMidpoint(g.points)} zoom={zoom} fontSize={m.style.fontSize} color={stroke || '#e03131'} warn={!scale}
            text={scale ? formatFeetInches(feetOf(g.points, scale)) : 'Set scale'} />
        </>
      )
    case 'measure-area':
      return (
        <>
          <Line {...common} closed fill={hexAlpha(fill || stroke || '#e03131', 0.22)} />
          <MeasureLabel at={polygonCentroid(g.points)} zoom={zoom} fontSize={m.style.fontSize} color={stroke || '#e03131'} warn={!scale}
            text={scale ? `${formatArea(sqftOf(g.points, scale))}\nP${formatFeetInches(polygonPerimeter(g.points) / scale)}` : 'Set scale'} />
        </>
      )
    case 'count': {
      const r = 9
      return (
        <>
          <Circle x={g.points[0]} y={g.points[1]} radius={r} fill={stroke || '#e03131'} stroke="#fff" strokeWidth={1.5} />
          <Text text={String(countNumber ?? '')} x={g.points[0] - r} y={g.points[1] - r} width={r * 2} height={r * 2}
            align="center" verticalAlign="middle" fontSize={r * (countNumber && countNumber > 9 ? 0.95 : 1.2)} fontStyle="bold" fill="#fff"
            fontFamily={FONT_MONO} listening={false} />
        </>
      )
    }
    case 'cable':
      return (
        <>
          <Line {...common} />
          {scale && <MeasureLabel at={pathMidpoint(g.points)} zoom={zoom} fontSize={m.style.fontSize} color={stroke || '#e03131'}
            text={formatFeetInches(feetOf(g.points, scale))} />}
          <Circle x={g.points[0]} y={g.points[1]} radius={strokeWidth * 1.6} fill={stroke || '#e03131'} />
          <Circle x={g.points[g.points.length - 2]} y={g.points[g.points.length - 1]} radius={strokeWidth * 1.6} fill={stroke || '#e03131'} />
        </>
      )
    default:
      return <Line {...common} />
  }
}

function PointHandles({ points, zoom, onChange }: { points: number[]; zoom: number; onChange: (p: number[], done: boolean) => void }) {
  const handles = []
  for (let i = 0; i < points.length; i += 2) {
    const idx = i
    const move = (e: Konva.KonvaEventObject<DragEvent>, done: boolean) => {
      e.cancelBubble = true
      const next = points.slice()
      next[idx] = e.target.x()
      next[idx + 1] = e.target.y()
      onChange(next, done)
    }
    handles.push(
      <Circle key={i} name="point-handle" x={points[i]} y={points[i + 1]} radius={6 / zoom}
        fill="#fff" stroke="#1971c2" strokeWidth={2 / zoom} draggable
        onDragStart={e => { e.cancelBubble = true }}
        onDragMove={e => move(e, false)} onDragEnd={e => move(e, true)} />,
    )
  }
  return <>{handles}</>
}

/**
 * Area: dashed muted outline and very light fill that cannot be hit (only the wide outline stroke
 * and the label can), so devices, panning and placing work through it. The label sits at the
 * top-left vertex, sized in screen pixels, with the parent path as a small breadcrumb.
 * The sheet area draws nothing but its label, pinned to the page corner.
 */
function AreaBody({ m, g, zoom, path }: { m: Markup; g: PathGeometry; zoom: number; path?: string[] }) {
  const sheet = m.fields?.sheet === true
  const { stroke, fill, strokeWidth, dash } = m.style
  const color = stroke || '#5f7a99'
  const name = m.text.trim() || 'Unnamed area'
  const crumbs = (path ?? [name]).slice(0, -1)
  // top-left-most vertex (smallest x + y)
  let ax = 0, ay = 0, best = Infinity
  for (let i = 0; i + 1 < g.points.length; i += 2) {
    const v = g.points[i] + g.points[i + 1]
    if (v < best) { best = v; ax = g.points[i]; ay = g.points[i + 1] }
  }
  const fs = 14 / zoom, small = 10.5 / zoom, pad = 5 / zoom
  const crumbText = crumbs.length ? `${crumbs.join(' â€º ')} â€º` : ''
  const halo = { stroke: '#fff', fillAfterStrokeEnabled: true, fontFamily: FONT_UI, lineHeight: 1.15 }
  return (
    <>
      {!sheet && (
        <>
          <Line points={g.points} closed fill={hexAlpha(fill || color, 0.06)} listening={false} />
          <Line points={g.points} closed stroke={color} strokeWidth={strokeWidth} lineJoin="round"
            dash={dash ? [strokeWidth * 4, strokeWidth * 3] : undefined} hitStrokeWidth={Math.max(strokeWidth, 14 / zoom)} />
        </>
      )}
      {crumbText && (
        <Text text={crumbText} x={ax + pad} y={ay + pad} fontSize={small} fill={color} strokeWidth={small * 0.25} {...halo}
          listening={false} />
      )}
      <Text text={name} x={ax + pad} y={ay + pad + (crumbText ? small * 1.2 : 0)} fontSize={fs} fontStyle="bold" fill={color}
        strokeWidth={fs * 0.22} {...halo} />
    </>
  )
}
