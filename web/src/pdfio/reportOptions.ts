import { naturalCompare } from '../markups/stacks'
import type { ScheduleRow } from '../schedule/rows'
import { parsePageRange } from './pageSubset'

export type ReportGroupBy = 'area' | 'set' | 'sheet'
export type ReportPhotos = 'none' | 'first' | 'all'
export type PhotosPerPage = 2 | 4 | 6

/** Everything the as-built report dialog asks for. Remembered between runs in the user prefs. */
export interface ReportOptions {
  titlePage: boolean
  address: string
  companyName: string
  preparedBy: string
  /** yyyy-mm-dd; blank = the day the report is made. */
  date: string
  /** Plans to include; null = every plan. */
  docIds: string[] | null
  /** Pages per plan id, e.g. "1-3, 5"; blank or missing = every page. */
  pageRanges: Record<string, string>
  includeSheets: boolean
  includeDevices: boolean
  /** Device statuses to include ('none' = no status set); empty = all. */
  statuses: string[]
  /** Symbol set ids to include; empty = all. */
  setIds: string[]
  groupBy: ReportGroupBy
  photos: ReportPhotos
  photosPerPage: PhotosPerPage
  includeEmptyFields: boolean
  includeBom: boolean
  includeLegend: boolean
  /** Append the wiring riser (tabloid pages) built from the cable runs. */
  includeWiring: boolean
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  titlePage: true, address: '', companyName: '', preparedBy: '', date: '',
  docIds: null, pageRanges: {}, includeSheets: true, includeDevices: true,
  statuses: [], setIds: [], groupBy: 'sheet', photos: 'all', photosPerPage: 4,
  includeEmptyFields: true, includeBom: false, includeLegend: false, includeWiring: false,
}

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every(x => typeof x === 'string') ? v : null)

/** Accepts anything (saved prefs from an older version, hand-edited) and returns complete, valid options. */
export function normalizeReportOptions(raw: unknown): ReportOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const D = DEFAULT_REPORT_OPTIONS
  const ranges: Record<string, string> = {}
  if (r.pageRanges && typeof r.pageRanges === 'object') for (const [k, v] of Object.entries(r.pageRanges)) if (typeof v === 'string' && v.trim()) ranges[k] = v
  return {
    titlePage: bool(r.titlePage, D.titlePage),
    address: str(r.address), companyName: str(r.companyName), preparedBy: str(r.preparedBy),
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
    docIds: r.docIds === null ? null : strings(r.docIds) ?? D.docIds,
    pageRanges: ranges,
    includeSheets: bool(r.includeSheets, D.includeSheets),
    includeDevices: bool(r.includeDevices, D.includeDevices),
    statuses: strings(r.statuses) ?? [],
    setIds: strings(r.setIds) ?? [],
    groupBy: r.groupBy === 'area' || r.groupBy === 'set' || r.groupBy === 'sheet' ? r.groupBy : D.groupBy,
    photos: r.photos === 'none' || r.photos === 'first' || r.photos === 'all' ? r.photos : D.photos,
    photosPerPage: r.photosPerPage === 2 || r.photosPerPage === 4 || r.photosPerPage === 6 ? r.photosPerPage : D.photosPerPage,
    includeEmptyFields: bool(r.includeEmptyFields, D.includeEmptyFields),
    includeBom: bool(r.includeBom, D.includeBom),
    includeLegend: bool(r.includeLegend, D.includeLegend),
    includeWiring: bool(r.includeWiring, D.includeWiring),
  }
}

/** Drops values that only make sense for one project (plan ids) so they are not remembered across projects. */
export const rememberableOptions = (o: ReportOptions): ReportOptions => ({ ...o, docIds: null, pageRanges: {}, setIds: [] })

/** Pages of a plan the report covers (every page when no range is given or the range is invalid). */
export function reportPages(o: Pick<ReportOptions, 'pageRanges'>, docId: string, pageCount: number): number[] {
  const all = Array.from({ length: pageCount }, (_, i) => i + 1)
  const text = o.pageRanges[docId]
  if (!text?.trim()) return all
  const { pages, error } = parsePageRange(text, pageCount)
  return error || !pages.length ? all : pages
}

/** Error text for a plan's page range, or '' when it is fine (blank is fine). */
export function pageRangeError(text: string, pageCount: number): string {
  return text.trim() ? parsePageRange(text, pageCount).error ?? '' : ''
}

/** Whether a device row passes the plan / page / status / symbol set filters. */
export function rowIncluded(r: Pick<ScheduleRow, 'documentId' | 'page' | 'status' | 'setId'>, o: ReportOptions, pageCounts: Map<string, number>): boolean {
  if (o.docIds && !o.docIds.includes(r.documentId)) return false
  if (!reportPages(o, r.documentId, pageCounts.get(r.documentId) ?? 9999).includes(r.page)) return false
  if (o.statuses.length && !o.statuses.includes(r.status || 'none')) return false
  if (o.setIds.length && !o.setIds.includes(r.setId)) return false
  return true
}

export interface RowGroup<T> { title: string; rows: T[] }

/** Devices grouped for the report. Sheets keep their given order; areas and sets sort by name. Rows keep their order inside a group. */
export function groupRows<T extends Pick<ScheduleRow, 'areaText' | 'setName' | 'sheet'>>(rows: T[], by: ReportGroupBy): RowGroup<T>[] {
  const titleOf = (r: T) => (by === 'area' ? r.areaText || 'No area' : by === 'set' ? r.setName || 'No symbol set' : r.sheet || 'No sheet')
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const t = titleOf(r)
    const l = groups.get(t)
    if (l) l.push(r); else groups.set(t, [r])
  }
  const out = [...groups].map(([title, rs]) => ({ title, rows: rs }))
  return by === 'sheet' ? out : out.sort((a, b) => naturalCompare(a.title, b.title))
}

/** Photos kept for a device. */
export function limitPhotos<T>(photos: T[], mode: ReportPhotos): T[] {
  return mode === 'none' ? [] : mode === 'first' ? photos.slice(0, 1) : photos
}

/** Columns x rows of the photo grid for a "photos per page" setting. */
export function photoGrid(perPage: PhotosPerPage): { cols: number; rows: number } {
  return perPage === 2 ? { cols: 1, rows: 2 } : perPage === 6 ? { cols: 2, rows: 3 } : { cols: 2, rows: 2 }
}

/** Label / value pairs with the empty ones removed unless empty fields are wanted. */
export function visiblePairs(pairs: [string, string][], includeEmpty: boolean): [string, string][] {
  return includeEmpty ? pairs : pairs.filter(([, v]) => v.trim() !== '' && v.trim() !== '-')
}

export interface CountLine { label: string; count: number }

/** Device counts by symbol set > device type (the legend summary), biggest groups in name order. */
export function deviceCounts(rows: Pick<ScheduleRow, 'setName' | 'typeName'>[]): CountLine[] {
  const m = new Map<string, number>()
  for (const r of rows) {
    const label = [r.setName, r.typeName].filter(Boolean).join(' > ') || 'Device'
    m.set(label, (m.get(label) ?? 0) + 1)
  }
  return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => naturalCompare(a.label, b.label))
}
