import { iconRect, mountShape } from '../markups/mount'
import type { Mount } from '../markups/mount'

interface Props {
  mount: Mount
  color: string
  /** Icon image (data URL), drawn white inside the shape the way devices draw it. Omit for the bare shape. */
  src?: string
  /** Side of the badge in px (default 32). */
  size?: number
  /** Wall only: direction the round side points (default up, so the flat side is down). */
  facing?: number
  title?: string
}

/** A device's container as a small preview: the mount shape in the category colour with the icon inside. */
export function MountBadge({ mount, color, src, size = 32, facing = -90, title }: Props) {
  const shape = mountShape(mount, 1, facing)
  const pts = shape.outline
  let d = ''
  for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i].toFixed(3)} ${pts[i + 1].toFixed(3)} `
  d += 'Z'
  const ic = iconRect(shape)
  return (
    <svg className="mount-badge" width={size} height={size} viewBox="-1.1 -1.1 2.2 2.2" role="img" aria-label={title ?? `${mount} mount`} style={{ flexShrink: 0 }}>
      {title && <title>{title}</title>}
      <path d={d} fill={color} stroke="#fff" strokeWidth={0.06} strokeLinejoin="round" />
      {src && <image href={src} x={ic.x} y={ic.y} width={ic.size} height={ic.size} />}
    </svg>
  )
}
