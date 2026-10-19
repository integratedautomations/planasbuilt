import { api } from '../api'
import type { Markup, SymbolSet } from '../markups/types'
import { buildRows, exportFileName, exportTables } from './rows'

export interface ProjectScaleRow { document_id: string; page: number; points_per_foot: number; label: string }

export const scaleKey = (documentId: string, page: number) => `${documentId}|${page}`

/** Fetches the whole project and downloads the device schedule workbook. */
export async function exportProjectSchedule(projectId: string, projectName: string) {
  const [markups, scales, sets] = await Promise.all([
    api<Markup[]>(`/projects/${projectId}/markups`),
    api<ProjectScaleRow[]>(`/projects/${projectId}/scales`).catch(() => [] as ProjectScaleRow[]),
    api<SymbolSet[]>('/symbol-sets'),
  ])
  const ppf = new Map(scales.map(s => [scaleKey(s.document_id, s.page), s.points_per_foot]))
  const rows = buildRows(markups, {
    symbolSets: new Map(sets.map(s => [s.id, s])), showAll: true,
    scaleFor: (d, p) => ppf.get(scaleKey(d, p)) ?? null,
  })
  const { downloadWorkbook } = await import('./xlsxIO')
  await downloadWorkbook(exportTables(rows, sets), exportFileName(projectName))
}
