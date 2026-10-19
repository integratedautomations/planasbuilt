// All geometry is in PDF page points at scale 1, origin top-left, y down (pdf.js viewport space).

export type BoxType = 'rect' | 'ellipse' | 'cloud' | 'highlight' | 'text' | 'stamp'
export type PathType = 'line' | 'arrow' | 'polyline' | 'polygon' | 'freehand'
export type MarkupType = BoxType | PathType

export const BOX_TYPES: MarkupType[] = ['rect', 'ellipse', 'cloud', 'highlight', 'text', 'stamp']
export const isBoxType = (t: MarkupType): t is BoxType => BOX_TYPES.includes(t)

export interface BoxGeometry { x: number; y: number; width: number; height: number; rotation: number }
/** points are relative to x/y: [x0, y0, x1, y1, ...] */
export interface PathGeometry { x: number; y: number; rotation: number; points: number[] }

export interface MarkupStyle {
  stroke: string
  fill: string            // '' = no fill
  strokeWidth: number
  opacity: number
  fontSize: number
  dash?: boolean
}

export interface Markup {
  id: string
  document_id: string
  page: number
  type: MarkupType
  geometry: BoxGeometry | PathGeometry
  style: MarkupStyle
  text: string
  layer_id: string | null
  version?: number
  created_by?: string
  updated_by?: string
  updated_at?: string
}

export interface Layer { id: string; project_id: string; name: string; color: string; sort: number }

export type Tool = 'select' | 'pan' | MarkupType

export const DEFAULT_STYLE: MarkupStyle = {
  stroke: '#e03131', fill: '', strokeWidth: 3, opacity: 1, fontSize: 18,
}

export function defaultStyleFor(type: MarkupType, base: MarkupStyle): MarkupStyle {
  if (type === 'highlight') return { ...base, stroke: '', fill: '#ffd43b', opacity: 0.4 }
  if (type === 'stamp') return { ...base, fontSize: 28 }
  return base
}
