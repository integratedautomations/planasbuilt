import { useRef } from 'react'
import { Arrow, Circle, Ellipse, Group, Image as KImage, Line, Rect, Shape, Text, Wedge } from 'react-konva'
import type Konva from 'konva'
import { cloudArcs, deviceCenter } from './geometry'
import { STATUSES } from './types'
import type { BoxGeometry, Fov, Markup, PathGeometry, SymbolSet } from './types'
import { useImage } from './useImage'

interface Props {
  markup: Markup
  zoom: number
  symbolSet?: SymbolSet
  draggable?: boolean
  listening?: boolean
  /** Show per-point handles (single selected path markup). */
  editPoints?: boolean
  onPointsChange?: (points: number[], done: boolean) => void
  /** Show the coverage-cone handle (single selected camera). */
  editFov?: boolean
  onFovChange?: (fov: Fov, done: boolean) => void
  onDragEnd?: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDblClick?: () => void
}

/**
 * Every markup is a Group positioned at geometry x/y/rotation. Boxes draw children at
 * 0..width × 0..height; paths draw their relative points. The Transformer scales the
 * Group, and the scale is baked back into geometry on transform end.
 * A device's coverage cone is a sibling (outside the Group) so resizing the
 * icon doesn't stretch the cone.
 */
export function MarkupShape(props: Props) {
  const { markup: m, zoom, symbolSet, draggable, listening = true, editPoints, onPointsChange, editFov, onFovChange, onDragEnd, onDblClick } = props
  const g = m.geometry
  const fovRef = useRef<Konva.Group>(null)
  const fov = m.type === 'device' && symbolSet?.has_fov && 'width' in g ? g.fov : undefined

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
        {'points' in g ? <PathBody m={m} g={g} zoom={zoom} />
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

function PathBody({ m, g, zoom }: { m: Markup; g: PathGeometry; zoom: number }) {
  const { stroke, fill, strokeWidth, dash } = m.style
  const common = {
    points: g.points, stroke: stroke || '#e03131', strokeWidth,
    dash: dash ? [strokeWidth * 4, strokeWidth * 3] : undefined,
    hitStrokeWidth: Math.max(strokeWidth, 12 / zoom),
    lineCap: 'round' as const, lineJoin: 'round' as const,
  }
  switch (m.type) {
    case 'arrow':
      return <Arrow {...common} fill={stroke || '#e03131'} pointerLength={strokeWidth * 4 + 6} pointerWidth={strokeWidth * 3 + 6} />
    case 'polygon':
      return <Line {...common} closed fill={fill || 'transparent'} />
    case 'freehand':
      return <Line {...common} tension={0.4} />
    case 'cable':
      return (
        <>
          <Line {...common} />
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
