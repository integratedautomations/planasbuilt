import { useRef } from 'react'
import { Arrow, Circle, Ellipse, Group, Image as KImage, Line, Rect, Shape, Text, Wedge } from 'react-konva'
import type Konva from 'konva'
import { cloudArcs, deviceCenter } from './geometry'
import { feetOf, formatArea, formatFeetInches, pathMidpoint, polygonCentroid, polygonPerimeter, sqftOf } from './measure'
import { STATUSES } from './types'
import type { BoxGeometry, Fov, Markup, PathGeometry, SymbolSet } from './types'
import { useImage } from './useImage'

interface Props {
  markup: Markup
  zoom: number
  /** points_per_foot for this markup's page (null = not calibrated). */
  scale?: number | null
  /** 1-based number shown on a count marker. */
  countNumber?: number
  symbolSet?: SymbolSet
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
  onDragEnd?: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDblClick?: () => void
}

/**
 * Every markup is a Group positioned at geometry x/y/rotation. Boxes draw children at
 * 0..width Ã— 0..height; paths draw their relative points. The Transformer scales the
 * Group, and the scale is baked back into geometry on transform end.
 * A device's coverage cone is a sibling (outside the Group) so resizing the
 * icon doesn't stretch the cone.
 */
export function MarkupShape(props: Props) {
  const { markup: m, zoom, scale = null, countNumber, symbolSet, areaPath, draggable, listening = true, editPoints, onPointsChange, editFov, onFovChange, onDragEnd, onDblClick, showCones = true } = props
  const g = m.geometry
  const fovRef = useRef<Konva.Group>(null)
  const fov = m.type === 'device' && symbolSet?.has_fov && 'width' in g && showCones && !g.fov?.hidden ? g.fov : undefined

  // Keep the cone attached while the device is being dragged
  const onDragMove = (e: Konva.KonvaEventObject<DragEvent>) => {
    if (!fovRef.current || !('width' in g) || e.target.name() !== 'markup') return
    const c = deviceCenter({ ...g, x: e.target.x(), y: e.target.y() })
    fovRef.current.position(c)
  }

  return (
    <>
      {fov && 'width' in g && (
        <FovCone innerRef={fovRef} center={deviceCenter(g)} fov={fov} color={symbolSet!.color} zoom={zoom}
          editable={!!editFov} onChange={onFovChange} />
      )}
      <Group id={m.id} name="markup" x={g.x} y={g.y} rotation={g.rotation}
        draggable={draggable} listening={listening} opacity={m.style.opacity}
        onDragMove={fov ? onDragMove : undefined}
        onDragEnd={onDragEnd} onDblClick={onDblClick} onDblTap={onDblClick}>
        {'points' in g ? <PathBody m={m} g={g} zoom={zoom} scale={scale} countNumber={countNumber} areaPath={areaPath} />
          : m.type === 'device' ? <DeviceBody m={m} g={g} set={symbolSet} />
          : <BoxBody m={m} g={g} />}
        {editPoints && 'points' in g && onPointsChange && (
          <PointHandles points={g.points} zoom={zoom} onChange={onPointsChange} />
        )}
      </Group>
    </>
  )
}

function DeviceBody({ m, g, set }: { m: Markup; g: BoxGeometry; set?: SymbolSet }) {
  const icon = useImage(set?.icon)
  const color = set?.color ?? '#868e96'
  const r = Math.min(g.width, g.height) / 2
  const status = STATUSES.find(s => s.value === m.status)
  const fontSize = Math.max(4, r * 0.7)
  const label = m.tag || set?.tag_prefix || '?'
  return (
    <>
      <Circle x={g.width / 2} y={g.height / 2} radius={r} fill={color} stroke="#fff" strokeWidth={r * 0.12} />
      {icon && <KImage image={icon} x={g.width / 2 - r * 0.62} y={g.height / 2 - r * 0.62} width={r * 1.24} height={r * 1.24} />}
      {status && (
        <Circle x={g.width / 2 + r * 0.75} y={g.height / 2 - r * 0.75} radius={r * 0.3}
          fill={status.color} stroke="#fff" strokeWidth={r * 0.08} />
      )}
      <Text text={label} x={g.width / 2 - 100} y={g.height / 2 + r + r * 0.12} width={200} align="center"
        fontSize={fontSize} fontStyle="bold" fill={color} stroke="#fff" strokeWidth={fontSize * 0.18}
        fillAfterStrokeEnabled fontFamily="system-ui, sans-serif" listening={false} />
    </>
  )
}

function FovCone({ innerRef, center, fov, color, zoom, editable, onChange }: {
  innerRef: React.RefObject<Konva.Group | null>; center: { x: number; y: number }; fov: Fov; color: string
  zoom: number; editable: boolean; onChange?: (f: Fov, done: boolean) => void
}) {
  const rad = (fov.direction * Math.PI) / 180
  const tip = { x: Math.cos(rad) * fov.range, y: Math.sin(rad) * fov.range }
  const drag = (e: Konva.KonvaEventObject<DragEvent>, done: boolean) => {
    e.cancelBubble = true
    const x = e.target.x(), y = e.target.y()
    onChange?.({ ...fov, direction: Math.round((Math.atan2(y, x) * 180) / Math.PI), range: Math.max(10, Math.hypot(x, y)) }, done)
  }
  return (
    <Group ref={innerRef} x={center.x} y={center.y} listening={editable}>
      <Wedge radius={fov.range} angle={fov.angle} rotation={fov.direction - fov.angle / 2}
        fill={color} opacity={0.18} stroke={color} strokeWidth={1.5 / zoom} listening={false} />
      {editable && (
        <Circle name="point-handle" x={tip.x} y={tip.y} radius={7 / zoom} fill="#fff" stroke={color}
          strokeWidth={2 / zoom} draggable onDragStart={e => { e.cancelBubble = true }}
          onDragMove={e => drag(e, false)} onDragEnd={e => drag(e, true)} />
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
            fontSize={m.style.fontSize} fill={stroke || '#000'} fontFamily="system-ui, sans-serif" />
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
            fontSize={fontSize} fontStyle="bold" fill={stroke || '#e03131'} fontFamily="system-ui, sans-serif" />
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
      fillAfterStrokeEnabled fontFamily="system-ui, sans-serif" listening={false} />
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
            fontFamily="system-ui, sans-serif" listening={false} />
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
  const crumbText = crumbs.length ? `${crumbs.join(' › ')} ›` : ''
  const halo = { stroke: '#fff', fillAfterStrokeEnabled: true, fontFamily: 'system-ui, sans-serif', lineHeight: 1.15 }
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
