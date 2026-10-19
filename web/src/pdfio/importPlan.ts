import { PDFDocument } from 'pdf-lib'
import type { Change } from '../markups/useMarkups'
import type { Markup } from '../markups/types'
import { uuid } from '../uuid'
import { mapAnnotation, parsePayload } from './importMap'
import { readAnnotations } from './reader'

export interface ImportContext {
  documentId: string
  /** Markups already in this document (by id). */
  existing: Map<string, Markup>
  newId?: () => string
}

export interface ImportPlan {
  /** One undoable step for markups.commit. */
  changes: Change
  /** Markups restored exactly from our /PlanAsBuilt data. */
  restored: number
  /** Standard annotations converted to markups. */
  mapped: number
  /** Restored markups identical to what the document already has. */
  unchanged: number
  /** Annotations of kinds we don't import (notes, links, ...). */
  skipped: number
  /** Counts by resulting markup type. */
  byType: Record<string, number>
}

/** Fields that come from the server and must not be copied onto a new markup. */
const SERVER_FIELDS = ['version', 'created_by', 'updated_by', 'created_by_name', 'updated_by_name', 'created_at', 'updated_at', 'document_name', 'photo_count'] as const

const same = (a: Markup, b: Markup) => JSON.stringify([a.page, a.type, a.geometry, a.style, a.text, a.tag ?? '', a.status ?? '', a.fields ?? {}, a.symbol_set_id ?? null, a.device_type_id ?? null, a.product_id ?? null])
  === JSON.stringify([b.page, b.type, b.geometry, b.style, b.text, b.tag ?? '', b.status ?? '', b.fields ?? {}, b.symbol_set_id ?? null, b.device_type_id ?? null, b.product_id ?? null])

/** Reads an annotated PDF and works out which markups to add or update. Nothing is saved here. */
export async function planImport(bytes: ArrayBuffer | Uint8Array, ctx: ImportContext): Promise<ImportPlan> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const newId = ctx.newId ?? uuid
  const plan: ImportPlan = { changes: [], restored: 0, mapped: 0, unchanged: 0, skipped: 0, byType: {} }
  const seen = new Set<string>()
  const count = (type: string) => { plan.byType[type] = (plan.byType[type] ?? 0) + 1 }

  for (const { box, annots } of readAnnotations(doc)) {
    for (const a of annots) {
      const payload = parsePayload(a.payload)
      if (payload) {
        const sameDoc = payload.document_id === ctx.documentId
        const id = sameDoc ? payload.id : newId()
        if (seen.has(id)) continue
        seen.add(id)
        const existing = sameDoc ? ctx.existing.get(id) : undefined
        const clean: Markup = { ...payload, id, document_id: ctx.documentId, page: a.page }
        for (const k of SERVER_FIELDS) delete clean[k]
        if (!sameDoc) { clean.layer_id = null; if (clean.type === 'device') clean.tag = '' } // the server numbers new devices
        if (existing) {
          const after: Markup = { ...existing, ...clean, layer_id: existing.layer_id }
          if (same(existing, after)) { plan.unchanged++; continue }
          plan.changes.push({ before: existing, after })
        } else plan.changes.push({ before: null, after: clean })
        plan.restored++
        count(clean.type)
        continue
      }
      if (a.flags & 2) continue // hidden foreign annotation
      const mapped = mapAnnotation(a, box)
      if (!mapped.length) { plan.skipped++; continue }
      for (const m of mapped) {
        plan.changes.push({
          before: null,
          after: { id: newId(), document_id: ctx.documentId, page: m.page, type: m.type, geometry: m.geometry, style: m.style, text: m.text, layer_id: null },
        })
        plan.mapped++
        count(m.type)
      }
    }
  }
  return plan
}
