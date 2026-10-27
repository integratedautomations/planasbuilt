import { api } from '../api'
import type { CatalogData } from '../catalog/types'
import type { Layer, Markup, SymbolSet } from '../markups/types'
import { flushWrites, queueMarkupPut, queueScalePut } from '../offline/sync'
import { stripImportedAnnotations } from './annotStrip'
import type { AnnotSummary } from './annotStrip'
import { planImport } from './importPlan'
import type { ImportPlan } from './importPlan'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** "N markups (M devices, ...)" for the upload prompt. */
export function describeSummary(s: AnnotSummary): string {
  const parts = [plural(s.devices, 'device')]
  const others = s.markups - s.devices
  if (others > 0) parts.push(plural(others, 'other markup'))
  return `${plural(s.markups, s.restored ? 'PlanAsBuilt markup' : 'markup')} (${parts.join(', ')})`
}

/** Works out the import of an uploaded PDF into a document that was just created from it (or got it as a new revision). */
export async function planUploadImport(bytes: ArrayBuffer, projectId: string, documentId: string, existing: Map<string, Markup>): Promise<ImportPlan> {
  const [sets, cat, layers] = await Promise.all([
    api<SymbolSet[]>('/symbol-sets').catch(() => [] as SymbolSet[]),
    api<CatalogData>('/catalog').catch(() => ({ device_types: [], products: [] }) as CatalogData),
    api<Layer[]>(`/projects/${projectId}/layers`).catch(() => [] as Layer[]),
  ])
  return planImport(bytes, {
    documentId, existing, keepTags: true,
    known: { layers: new Set(layers.map(l => l.id)), symbolSets: new Set(sets.map(s => s.id)), deviceTypes: new Set(cat.device_types.map(t => t.id)), products: new Set(cat.products.map(p => p.id)) },
    typeIdByName: new Map(cat.device_types.map(t => [t.name.toLowerCase(), t.id])),
    setIdByName: new Map(sets.map(s => [s.name.toLowerCase(), s.id])),
  })
}

/** Saves the planned markups (and restored page scales) through the outbox, so it works the same offline. */
export async function applyUploadImport(documentId: string, plan: ImportPlan) {
  for (const c of plan.changes) if (c.after) await queueMarkupPut(documentId, c.after, { restore: true })
  for (const [page, ppf] of plan.scales) await queueScalePut(documentId, [page], { points_per_foot: ppf, label: 'Imported scale' })
  await flushWrites()
}

/** The uploaded file with the annotations an import takes over removed, so they are not drawn twice. */
export async function strippedFile(file: File, bytes: ArrayBuffer): Promise<File> {
  return new File([(await stripImportedAnnotations(bytes)) as BlobPart], file.name, { type: 'application/pdf' })
}
