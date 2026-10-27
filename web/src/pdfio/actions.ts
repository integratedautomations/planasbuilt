import { api, attachmentFileUrl, authFetch } from '../api'
import type { Attachment, DocumentSummary } from '../api'
import type { CatalogData, DeviceType } from '../catalog/types'
import { buildCatalog } from '../catalog/catalog'
import type { Catalog } from '../catalog/catalog'
import type { Markup, SymbolSet } from '../markups/types'
import { loadPdfBytes } from '../offline/cache'
import { authorOptions } from './annots'
import { exportAnnotated, exportFileName, exportFlattened } from './build'
import { downloadBytes } from './download'
import { loadIcons } from './icons'
import { planImport } from './importPlan'
import type { ImportPlan } from './importPlan'
import type { KnownIds } from './importMap'
import { buildReport } from './report'
import { loadCompany } from '../settings/company'
import { DEFAULT_REPORT_OPTIONS } from './reportOptions'
import type { ReportOptions } from './reportOptions'
import type { ReportPhoto } from './report'
import { cableSettings } from '../markups/cables'
import type { Project } from '../api'
import { normalizeSettings } from '../projectSettings'

export interface DocExportArgs {
  documentId: string
  name: string
  markups: Iterable<Markup>
  symbolSets: Map<string, SymbolSet>
  /** Device types, so devices export with their type's icon. */
  deviceTypes?: Iterable<DeviceType>
  /** Points per foot by page. */
  scales: Map<number, number>
  catalog?: Catalog
  /** Name of the exporting user (for the company's PDF author setting). */
  exporter?: string
}

/** Downloads `<name>-markups.pdf` (editable annotations) or `<name>-flattened.pdf`. */
export async function exportDocumentPdf(kind: 'annotated' | 'flattened', a: DocExportArgs) {
  const [pdfBytes, icons] = await Promise.all([loadPdfBytes(a.documentId), loadIcons(a.symbolSets.values(), a.deviceTypes)])
  const input = { pdfBytes, markups: [...a.markups], symbolSets: a.symbolSets, scales: a.scales, icons, catalog: a.catalog, ...authorOptions(await loadCompany().catch(() => null), a.exporter) }
  const bytes = kind === 'annotated' ? await exportAnnotated(input) : await exportFlattened(input)
  downloadBytes(bytes, exportFileName(a.name, kind === 'annotated' ? 'markups' : 'flattened'))
}

/** Reads an annotated PDF picked by the user and works out what importing it would change. */
export async function planImportFile(file: File, documentId: string, existing: Map<string, Markup>, known?: KnownIds,
  names?: { typeIdByName?: ReadonlyMap<string, string>; setIdByName?: ReadonlyMap<string, string> }): Promise<ImportPlan> {
  return planImport(await file.arrayBuffer(), { documentId, existing, known, ...names })
}

interface ProjectScaleRow { document_id: string; page: number; points_per_foot: number }

/** Builds and downloads the as-built report for a whole project. */
export async function exportProjectReport(projectId: string, projectName: string, options: ReportOptions = DEFAULT_REPORT_OPTIONS, onProgress?: (done: number, total: number, label: string) => void) {
  const [docs, markups, scaleRows, sets, catData, project] = await Promise.all([
    // (catalog is optional: older servers / offline just report without product columns)
    api<DocumentSummary[]>(`/projects/${projectId}/documents`),
    api<Markup[]>(`/projects/${projectId}/markups`),
    api<ProjectScaleRow[]>(`/projects/${projectId}/scales`).catch(() => [] as ProjectScaleRow[]),
    api<SymbolSet[]>('/symbol-sets'),
    api<CatalogData>('/catalog').catch(() => ({ device_types: [], products: [] }) as CatalogData),
    api<Project>(`/projects/${projectId}`).catch(() => null),
  ])
  const catalog = buildCatalog(catData)
  const symbolSets = new Map(sets.map(s => [s.id, s]))
  const [icons, sheets] = await Promise.all([
    loadIcons(sets, catData.device_types),
    Promise.all(docs.filter(d => !options.docIds || options.docIds.includes(d.id)).map(async d => ({
      documentId: d.id, name: d.name, pdfBytes: await loadPdfBytes(d.id), deviceScale: d.device_scale ?? 1,
      scales: new Map(scaleRows.filter(s => s.document_id === d.id).map(s => [s.page, s.points_per_foot])),
    }))),
  ])
  const photosFor = async (markupId: string): Promise<ReportPhoto[]> => {
    const list = await api<Attachment[]>(`/markups/${markupId}/attachments`)
    const out: ReportPhoto[] = []
    for (const a of list) {
      try {
        const res = await authFetch(attachmentFileUrl(a.id, undefined, a.created_at)) // annotated version when there is one
        if (res.ok) out.push({ bytes: new Uint8Array(await res.arrayBuffer()), caption: a.caption })
      } catch { /* skip a photo that can't be fetched */ }
    }
    return out
  }
  // Sections the project switched off stay out of the report; the logo is the project's own, else the company's.
  const sec = normalizeSettings(project?.settings).report.sections
  const company = await loadCompany().catch(() => null)
  const allowed: ReportOptions = {
    ...options,
    preparedBy: options.preparedBy.trim() || company?.prepared_by || '',
    companyName: options.companyName.trim() || company?.name || '', titlePage: options.titlePage && sec.title, includeSheets: options.includeSheets && sec.sheets,
    includeDevices: options.includeDevices && sec.devices, photos: sec.photos ? options.photos : 'none',
    includeLegend: options.includeLegend && sec.legend, includeBom: options.includeBom && sec.bom, includeWiring: options.includeWiring && sec.wiring,
  }
  const logo = await authFetch(`/api/projects/${projectId}/logo`).then(async r => (r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined)).catch(() => undefined)
  const bytes = await buildReport({ projectName, date: new Date(), sheets, markups, symbolSets, catalog, icons, photosFor, onProgress, options: allowed, cableDefaults: cableSettings(project), logo })
  downloadBytes(bytes, exportFileName(projectName, 'as-built-report'))
}
