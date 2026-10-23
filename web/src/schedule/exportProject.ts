import { api } from '../api'
import { buildCatalog } from '../catalog/catalog'
import type { CatalogData } from '../catalog/types'
import type { Markup, SymbolSet } from '../markups/types'
import { buildRows, exportFileName, exportTables } from './rows'
import type { CableSettings } from '../markups/cables'

export interface ProjectScaleRow { document_id: string; page: number; points_per_foot: number; label: string }

export const scaleKey = (documentId: string, page: number) => `${documentId}|${page}`

/** Fetches the whole project and downloads the device schedule workbook. */
export async function exportProjectSchedule(projectId: string, projectName: string, cableDefaults?: CableSettings) {
  const [markups, scales, sets, cat] = await Promise.all([
    api<Markup[]>(`/projects/${projectId}/markups`),
    api<ProjectScaleRow[]>(`/projects/${projectId}/scales`).catch(() => [] as ProjectScaleRow[]),
    api<SymbolSet[]>('/symbol-sets'),
    api<CatalogData>('/catalog').catch(() => ({ device_types: [], products: [] }) as CatalogData),
  ])
  const ppf = new Map(scales.map(s => [scaleKey(s.document_id, s.page), s.points_per_foot]))
  const rows = buildRows(markups, {
    symbolSets: new Map(sets.map(s => [s.id, s])), catalog: buildCatalog(cat), showAll: true, cableDefaults,
    scaleFor: (d, p) => ppf.get(scaleKey(d, p)) ?? null,
  })
  const { downloadWorkbook } = await import('./xlsxIO')
  await downloadWorkbook(exportTables(rows, sets), exportFileName(projectName))
}
