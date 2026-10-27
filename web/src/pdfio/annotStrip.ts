import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib'
import { mapAnnotation } from './importMap'
import { planImport } from './importPlan'
import type { ImportPlan } from './importPlan'
import { readAnnotations, readSpaces } from './reader'

/** What an uploaded PDF holds that could become editable markups. */
export interface AnnotSummary {
  /** Markups (restored + converted) that an import would create. */
  markups: number
  /** Markups restored exactly from our /PlanAsBuilt data. */
  restored: number
  /** Devices among them. */
  devices: number
  /** Standard (e.g. Revu) annotations converted. */
  converted: number
  byType: Record<string, number>
  plan: ImportPlan
}

/** Looks for importable annotations. Returns null when there are none (or the PDF can't be read). */
export async function detectAnnotations(bytes: ArrayBuffer | Uint8Array): Promise<AnnotSummary | null> {
  try {
    const plan = await planImport(bytes, { documentId: '', existing: new Map() })
    const markups = plan.restored + plan.mapped
    if (!markups) return null
    return { markups, restored: plan.restored, devices: plan.byType.device ?? 0, converted: plan.mapped, byType: plan.byType, plan }
  } catch { return null }
}

/** Copy of the PDF without the annotations an import turns into markups (links, form fields and anything unmapped stay). */
export async function stripImportedAnnotations(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const gone = new Set<string>()
  for (const { box, annots } of readAnnotations(doc)) {
    for (const a of annots) {
      if (!a.ref) continue
      if (a.payload || (!(a.flags & 2) && mapAnnotation(a, box).length)) gone.add(a.ref)
    }
  }
  // Spaces become areas on import, so they are removed too
  const hasSpaces = readSpaces(doc).length > 0
  if (hasSpaces) for (const page of doc.getPages()) page.node.delete(PDFName.of('BSISpaces'))
  if (!gone.size && !hasSpaces) return new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer)
  for (const page of doc.getPages()) {
    const list = page.node.Annots()
    if (!list) continue
    for (let k = list.size() - 1; k >= 0; k--) {
      const item = list.get(k)
      const key = item instanceof PDFRef ? item.toString() : undefined
      if (key && gone.has(key)) { list.remove(k); continue }
      // a popup window of a removed annotation goes with it
      const d = doc.context.lookupMaybe(item, PDFDict)
      const irt = d?.get(PDFName.of('IRT'))
      if (d && irt instanceof PDFRef && gone.has(irt.toString()) && (d.has(PDFName.of('State')) || d.get(PDFName.of('RT')) === PDFName.of('Group'))) { list.remove(k); continue }
      const parent = d?.get(PDFName.of('Parent'))
      if (d && parent instanceof PDFRef && gone.has(parent.toString())) list.remove(k)
    }
  }
  return doc.save()
}
