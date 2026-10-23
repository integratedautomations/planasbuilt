// All geometry is in PDF page points at scale 1, origin top-left, y down (pdf.js viewport space).
import type { Mount } from './mount'

export type BoxType = 'rect' | 'ellipse' | 'cloud' | 'highlight' | 'text' | 'stamp' | 'device' | 'legend'
export type PathType = 'line' | 'arrow' | 'polyline' | 'polygon' | 'freehand' | 'cable'
  | 'measure-length' | 'measure-polylength' | 'measure-area' | 'measure-radius' | 'count' | 'area'
export type MarkupType = BoxType | PathType

export const BOX_TYPES: MarkupType[] = ['rect', 'ellipse', 'cloud', 'highlight', 'text', 'stamp', 'device', 'legend']
export const isBoxType = (t: MarkupType): t is BoxType => BOX_TYPES.includes(t)

/** Camera coverage wedge, in degrees and page points, from the device center. */
/**
 * Device coverage sector ("Coverage" in the UI; stored as `fov` for backward compatibility).
 * `range` is page points; `rangeFt` is the real length, used whenever the page has a scale.
 * `hidden` = coverage off for this device. `locked` = geometry cannot be edited. `opacity` = fill opacity (default 0.18).
 */
export interface Fov { direction: number; angle: number; range: number; hidden?: boolean; rangeFt?: number; locked?: boolean; opacity?: number }

/** `mount` overrides the device type's default mount shape for this device (absent = use the type's). */
export interface BoxGeometry { x: number; y: number; width: number; height: number; rotation: number; fov?: Fov; mount?: Mount }
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
  symbol_set_id?: string | null
  device_type_id?: string | null
  product_id?: string | null
  tag?: string
  status?: Status
  fields?: Record<string, string | number | boolean>
  version?: number
  created_by?: string
  updated_by?: string
  created_by_name?: string | null
  updated_by_name?: string | null
  created_at?: string
  updated_at?: string
  /** Only on rows from the project-wide list endpoint. */
  document_name?: string
  photo_count?: number
}

export type Status = '' | 'planned' | 'installed' | 'tested' | 'punch'
export const STATUSES: { value: Status; label: string; color: string }[] = [
  { value: 'planned', label: 'Planned', color: '#868e96' },
  { value: 'installed', label: 'Installed', color: '#1971c2' },
  { value: 'tested', label: 'Tested', color: '#2f9e44' },
  { value: 'punch', label: 'Punch', color: '#e03131' },
]

export type FieldType = 'text' | 'number' | 'select' | 'ip' | 'date' | 'checkbox'
export interface FieldDef { key: string; label: string; type: FieldType; options?: string[]; /** Hidden from clients. */ internal?: boolean }

/** Fields every device has, before its symbol set's own fields. */
export const HARDWARE_FIELDS: FieldDef[] = [
  { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
  { key: 'model', label: 'Model #', type: 'text' },
  { key: 'serial', label: 'Serial #', type: 'text' },
  { key: 'firmware', label: 'Firmware', type: 'text' },
]

export interface SymbolSet {
  id: string
  name: string
  color: string
  tag_prefix: string
  icon: string
  fields: FieldDef[]
  has_fov: boolean
  sort: number
}

export interface Layer { id: string; project_id: string; name: string; color: string; sort: number }

/** 'area-rect' is a drag-a-rectangle variant of 'area'; it stores a 4-point polygon of type 'area'. */
export type Tool = 'select' | 'pan' | 'calibrate' | 'area-rect' | MarkupType

export const DEFAULT_STYLE: MarkupStyle = {
  stroke: '#e03131', fill: '', strokeWidth: 3, opacity: 1, fontSize: 18,
}

/** Areas: muted dashed outline, very light fill. */
export const AREA_STYLE: MarkupStyle = { stroke: '#5f7a99', fill: '#5f7a99', strokeWidth: 2, opacity: 1, fontSize: 16, dash: true }

export function defaultStyleFor(type: MarkupType, base: MarkupStyle): MarkupStyle {
  if (type === 'highlight') return { ...base, stroke: '', fill: '#ffd43b', opacity: 0.4 }
  if (type === 'stamp') return { ...base, fontSize: 28 }
  if (type === 'cable') return { ...base, strokeWidth: 2, dash: true }
  if (type === 'measure-length' || type === 'measure-polylength' || type === 'measure-area' || type === 'measure-radius') return { ...base, strokeWidth: 2 }
  return base
}
