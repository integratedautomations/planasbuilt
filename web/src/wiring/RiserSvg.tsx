import type { Catalog } from '../catalog/catalog'
import { badgePath } from './layout'
import type { Prim, RiserPage } from './layout'

interface Props {
  page: RiserPage
  catalog: Catalog
  symbolSets: Map<string, { icon: string }>
  onDevice?: (id: string) => void
}

/** One riser page as SVG: the layout's primitives, with the same mount badges the plan draws. Clicking a device row calls onDevice. */
export function RiserSvg({ page, catalog, symbolSets, onDevice }: Props) {
  const icon = (p: Extract<Prim, { k: 'badge' }>) => catalog.types.get(p.typeId)?.icon || symbolSets.get(p.setId)?.icon || undefined
  return (
    <svg className="wiring-svg" viewBox={`0 0 ${page.width} ${page.height}`} role="img" aria-label={`${page.title}. ${page.subtitle}`}>
      <rect width={page.width} height={page.height} fill="#fff" />
      {page.prims.map((p, i) => {
        switch (p.k) {
          case 'rect': return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r} fill={p.fill ?? 'none'} stroke={p.stroke} strokeWidth={1} />
          case 'line': return <polyline key={i} points={p.pts.join(' ')} fill="none" stroke={p.color} strokeWidth={p.w ?? 1} strokeDasharray={p.dash ? '4 3' : undefined} strokeLinejoin="round" />
          case 'text': return <text key={i} x={p.x} y={p.y} fontSize={p.size} fontWeight={p.bold ? 700 : 400} fill={p.color} textAnchor={p.anchor ?? 'start'} fontFamily="Helvetica, Arial, sans-serif">{p.text}</text>
          case 'badge': {
            const src = icon(p)
            return (
              <g key={i} transform={`translate(${p.x} ${p.y})`}>
                <path d={badgePath(p.mount, p.r)} fill={p.color} stroke="#fff" strokeWidth={0.8} strokeLinejoin="round" />
                {src && <image href={src} x={-p.r * 0.62} y={-p.r * 0.62} width={p.r * 1.24} height={p.r * 1.24} />}
              </g>
            )
          }
          case 'hit': return (
            <rect key={i} className="wiring-hit" x={p.x} y={p.y} width={p.w} height={p.h} fill="transparent" onClick={() => onDevice?.(p.deviceId)}>
              <title>Open on plan</title>
            </rect>
          )
        }
      })}
    </svg>
  )
}
