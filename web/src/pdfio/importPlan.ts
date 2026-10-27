import { PDFDocument } from 'pdf-lib'
import type { Change } from '../markups/useMarkups'
import type { Markup } from '../markups/types'
import { uuid } from '../uuid'
import { mapAnnotation, mapSpace, parsePayload } from './importMap'
import type { KnownIds } from './importMap'
import { readAnnotations, readSpaces } from './reader'
import type { RawAnnot } from './reader'
import { STATUSES } from '../markups/types'

/** A Revu status reply: a Text annotation with /IRT and /State. */
export const isStatusReply = (a: RawAnnot) => a.subtype === 'Text' && !!a.irt && !!a.state

/** Tag text of grouped FreeText children (/RT /Group) by parent reference; only children of our own device stamps. */
export function tagChildrenOf(annots: RawAnnot[]): { texts: Map<string, string>; children: Set<RawAnnot> } {
  const heads = new Set(annots.filter(a => a.ref && a.payload && a.payload.includes('"device"')).map(a => a.ref!))
  const texts = new Map<string, string>(), children = new Set<RawAnnot>()
  for (const a of annots) {
    if (a.subtype !== 'FreeText' || a.rt !== 'Group' || !a.irt || !heads.has(a.irt)) continue
    children.add(a)
    const t = a.contents.replace(/[\r\n]+/g, ' ').trim()
    if (t && !texts.has(a.irt)) texts.set(a.irt, t)
  }
  return { texts, children }
}

/** Latest status reply (by /M) per parent reference. */
export function statusRepliesOf(annots: RawAnnot[]): Map<string, string> {
  const best = new Map<string, { state: string; m: string }>()
  for (const a of annots) {
    if (!isStatusReply(a)) continue
    const cur = best.get(a.irt!)
    if (!cur || (a.modified ?? '') >= cur.m) best.set(a.irt!, { state: a.state!, m: a.modified ?? '' })
  }
  return new Map([...best].map(([k, v]) => [k, v.state]))
}

export interface ImportContext {
  documentId: string
  /** Markups already in this document (by id). */
  existing: Map<string, Markup>
  newId?: () => string
  /** Ids that exist locally (layers, symbol sets, catalog). Payload references to anything else are dropped. */
  known?: KnownIds
  /** Lower-case device type / symbol set names to ids, so Revu edits of Subject / Layer map back (optional). */
  typeIdByName?: ReadonlyMap<string, string>
  setIdByName?: ReadonlyMap<string, string>
  /** Keep payload tags on devices from another document; the server renumbers any that collide. */
  keepTags?: boolean
  /** Lower-case status names to status ids; defaults to the active project's statuses. */
  statusIdByName?: ReadonlyMap<string, string>
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
  /** Page scales (points per foot) found in /Measure entries, by page. */
  scales: Map<number, number>
}

/** Fields that come from the server and must not be copied onto a new markup. */
const SERVER_FIELDS = ['version', 'created_by', 'updated_by', 'created_by_name', 'updated_by_name', 'created_at', 'updated_at', 'document_name', 'photo_count'] as const

const same = (a: Markup, b: Markup) => JSON.stringify([a.page, a.type, a.geometry, a.style, a.text, a.tag ?? '', a.status ?? '', a.fields ?? {}, a.symbol_set_id ?? null, a.device_type_id ?? null, a.product_id ?? null])
  === JSON.stringify([b.page, b.type, b.geometry, b.style, b.text, b.tag ?? '', b.status ?? '', b.fields ?? {}, b.symbol_set_id ?? null, b.device_type_id ?? null, b.product_id ?? null])

/** Reads an annotated PDF and works out which markups to add or update. Nothing is saved here. */
export async function planImport(bytes: ArrayBuffer | Uint8Array, ctx: ImportContext): Promise<ImportPlan> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const newId = ctx.newId ?? uuid
  const plan: ImportPlan = { changes: [], restored: 0, mapped: 0, unchanged: 0, skipped: 0, byType: {}, scales: new Map() }
  const seen = new Set<string>()
  const count = (type: string) => { plan.byType[type] = (plan.byType[type] ?? 0) + 1 }

  for (const { box, annots } of readAnnotations(doc)) {
    const replies = statusRepliesOf(annots)
    const tagKids = tagChildrenOf(annots)
    for (const a of annots) {
      if (isStatusReply(a) || tagKids.children.has(a)) continue
      if (a.measurePpf && !plan.scales.has(a.page)) plan.scales.set(a.page, a.measurePpf)
      const payload = parsePayload(a.payload, ctx.known)
      if (payload) {
        const sameDoc = payload.document_id === ctx.documentId
        const id = sameDoc ? payload.id : newId()
        if (seen.has(id)) continue
        seen.add(id)
        const existing = sameDoc ? ctx.existing.get(id) : undefined
        const clean: Markup = { ...payload, id, document_id: ctx.documentId, page: a.page }
        for (const k of SERVER_FIELDS) delete clean[k]
        if (clean.type === 'device') {
          // Revu columns win over the payload when edited there: Subject = device type, Layer (OC) = symbol set, Label = tag
          const t = a.subject ? ctx.typeIdByName?.get(a.subject.toLowerCase()) : undefined
          if (t) clean.device_type_id = t
          const sid = a.layer ? ctx.setIdByName?.get(a.layer.toLowerCase()) : undefined
          if (sid) clean.symbol_set_id = sid
          if (a.label !== undefined) clean.tag = a.label
          const kidTag = a.ref ? tagKids.texts.get(a.ref) : undefined
          if (kidTag) clean.tag = kidTag
          const stateLabel = a.ref ? replies.get(a.ref) : undefined
          if (stateLabel) {
            const key = stateLabel.trim().toLowerCase()
            const sid = ctx.statusIdByName ? ctx.statusIdByName.get(key) : STATUSES.find(s => s.label.toLowerCase() === key)?.value
            if (sid) clean.status = sid
          }
        }
        if (!sameDoc) { clean.layer_id = null; if (clean.type === 'device' && !ctx.keepTags) clean.tag = '' } // the server numbers new devices
        if (existing) {
          const after: Markup = { ...existing, ...clean, layer_id: clean.layer_id ?? existing.layer_id }
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

  // Revu Spaces (areas); ours carry a /PABPayload and are restored exactly
  for (const { box, spaces } of readSpaces(doc)) {
    for (const sp of spaces) {
      const payload = parsePayload(sp.payload, ctx.known)
      if (payload && payload.type === 'area') {
        const sameDoc = payload.document_id === ctx.documentId
        const id = sameDoc ? payload.id : newId()
        if (seen.has(id)) continue
        seen.add(id)
        const existing = sameDoc ? ctx.existing.get(id) : undefined
        const clean: Markup = { ...payload, id, document_id: ctx.documentId, page: sp.page }
        for (const k of SERVER_FIELDS) delete clean[k]
        if (!sameDoc) clean.layer_id = null
        if (existing) {
          const after: Markup = { ...existing, ...clean, layer_id: clean.layer_id ?? existing.layer_id }
          if (same(existing, after)) { plan.unchanged++; continue }
          plan.changes.push({ before: existing, after })
        } else plan.changes.push({ before: null, after: clean })
        plan.restored++
        count('area')
        continue
      }
      const m = mapSpace(sp, box)
      if (!m) { plan.skipped++; continue }
      plan.changes.push({
        before: null,
        after: { id: newId(), document_id: ctx.documentId, page: m.page, type: m.type, geometry: m.geometry, style: m.style, text: m.text, layer_id: null },
      })
      plan.mapped++
      count('area')
    }
  }
  return plan
}
