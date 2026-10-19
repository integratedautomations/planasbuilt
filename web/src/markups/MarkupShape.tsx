import { Arrow, Circle, Ellipse, Group, Line, Rect, Shape, Text } from 'react-konva'
import type Konva from 'konva'
import { cloudArcs } from './geometry'
import type { BoxGeometry, Markup, PathGeometry } from './types'

interface Props {
  markup: Markup
  zoom: number
  draggable?: boolean
  listening?: boolean
  /** Show per-point handles (single selected path markup). */
  editPoints?: boolean
  onPointsChange?: (points: number[], done: boolean) => void
  onDragEnd?: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDblClick?: () => void
}

/**
 * Every markup is a Group positioned at geometry x/y/rotation. Boxes draw children at
 * 0..width × 0..height; paths draw their relative points. The Transformer scales the
 * Group, and the scale is baked back into geometry on transform end.
 */
export function MarkupShape({ markup: m, zoom, draggable, listening = true, editPoints, onPointsChange, onDragEnd, onDblClick }: Props) {
  const g = m.geometry
  return (
    <Group id={m.id} name="markup" x={g.x} y={g.y} rotation={g.rotation}
      draggable={draggable} listening={listening} opacity={m.style.opacity}
      onDragEnd={onDragEnd} onDblClick={onDblClick} onDblTap={onDblClick}>
      {'points' in g ? <PathBody m={m} g={g} zoom={zoom} /> : <BoxBody m={m} g={g} />}
      {editPoints && 'points' in g && onPointsChange && (
        <PointHandles points={g.points} zoom={zoom} onChange={onPointsChange} />
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
