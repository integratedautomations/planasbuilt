import { PDFDocument } from 'pdf-lib'
import type { Change } from '../markups/useMarkups'
import { DEFAULT_STYLE } from '../markups/types'
import type { Markup } from '../markups/types'
import { productFields } from '../catalog/catalog'
import type { Catalog } from '../catalog/catalog'
import { uuid } from '../uuid'
import { boxFromPdfRect, mapAnnotation } from './importMap'
import { readAnnotations } from './reader'
import type { RawAnnot } from './reader'
import type { PageBox } from './coords'

// Bluebeam Revu stores a device as a group of annotations (a root plus children linked by /IRT + /RT /Group).
// This module turns those groups into device candidates and builds the import.

/** [x0, y0, x1, y1] in display (markup) space. */
export type Bounds = [number, number, number, number]

export interface RevuCandidate {
  id: string
  page: number
  kind: 'group' | 'stamp'
  /** Union of every member (display space). */
  bbox: Bounds
  /** Union of the members except the label text box: where the symbol itself sits. */
  symbolBox: Bounds
  layer: string
  label: string
  glyph: string
  subject: string
  signature: string
  /** Object references of all annotations that make up the device. */
  members: string[]
  hasImage: boolean
  /** The member annotations themselves (used when the group is imported as plain markups). */
  annots: RawAnnot[]
  box: PageBox
}

export interface RevuPlain { annot: RawAnnot; box: PageBox }

export interface RevuExtract {
  candidates: RevuCandidate[]
  /** Everything that is not part of a device: imported as plain markups. */
  others: RevuPlain[]
  /** Links, popups, widgets: never imported. */
  skipped: number
  pageBoxes: Map<number, PageBox>
}

/** Text that looks like a Revu device label ("SD-1", "OCAM-1", "M15-5", `7" ICM`). */
export const LABEL_RE = /^[A-Z0-9"' ]+-?\d*$/

export const cleanText = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

/** "Layer | label", else "Layer | subject". */
export function signatureOf(layer: string, label: string, subject: string): string {
  return `${layer || '(no layer)'} | ${label || subject || '(unnamed)'}`
}

/** Letters before the first dash or digit of a label: "SD-1" -> "SD", "M15-5" -> "M". */
export function labelPrefix(label: string): string {
  const m = /^([A-Za-z]+)/.exec(label.trim())
  return m ? m[1].toUpperCase() : ''
}

/** Picks the label and the glyph out of a group's text boxes. */
export function pickLabelAndGlyph(texts: string[]): { label: string; glyph: string } {
  const all = texts.map(cleanText).filter(Boolean)
  const labels = all.filter(t => LABEL_RE.test(t) && (t.length > 2 || /[-\d]/.test(t)))
  const label = labels.sort((a, b) => b.length - a.length)[0] ?? ''
  const glyphs = all.filter(t => t !== label && t.length <= 2 && /^[A-Za-z]+$/.test(t))
  let glyph = glyphs.sort((a, b) => a.length - b.length)[0] ?? ''
  let lab = label
  if (!lab) {
    // no label-shaped text: the longest longer text is the label, a lone 1-2 letter text is the glyph
    lab = all.filter(t => t.length > 2).sort((a, b) => b.length - a.length)[0] ?? ''
    if (!glyph) glyph = all.find(t => t.length <= 2) ?? ''
  }
  return { label: lab, glyph }
}

function union(boxes: Bounds[]): Bounds {
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))]
}

const area = (b: Bounds) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])

/** True when the overlap covers at least 80% of the smaller box. */
function overlapsMostly(a: Bounds, b: Bounds): boolean {
  const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])])
  const small = Math.min(area(a), area(b))
  return small > 0 && i / small >= 0.8
}

function displayBounds(a: RawAnnot, box: PageBox): Bounds {
  const g = boxFromPdfRect(box, a.rect)
  return [g.x, g.y, g.x + g.width, g.y + g.height]
}

/** Finds the device groups (and standalone stamps) of a Revu-marked document. */
export function extractRevu(doc: PDFDocument): RevuExtract {
  const out: RevuExtract = { candidates: [], others: [], skipped: 0, pageBoxes: new Map() }
  let total = 0, kept = 0
  doc.getPages().forEach(p => { total += p.node.Annots()?.size() ?? 0 })
  for (const { page, box, annots } of readAnnotations(doc)) {
    out.pageBoxes.set(page, box)
    kept += annots.length
    const byRef = new Map(annots.filter(a => a.ref).map(a => [a.ref!, a]))
    const isChild = (a: RawAnnot) => !!a.irt && a.rt === 'Group' && byRef.has(a.irt)
    const rootOf = (a: RawAnnot): RawAnnot => {
      let cur = a
      for (let i = 0; i < 20 && isChild(cur); i++) cur = byRef.get(cur.irt!)!
      return cur
    }
    const groups = new Map<RawAnnot, RawAnnot[]>()
    for (const a of annots) {
      if (!isChild(a)) continue
      const r = rootOf(a)
      const l = groups.get(r)
      if (l) l.push(a); else groups.set(r, [a])
    }
    for (const a of annots) {
      if (isChild(a)) continue
      const children = groups.get(a) ?? []
      const isStamp = a.subtype === 'Stamp' && !children.length
      if (!children.length && !isStamp) { out.others.push({ annot: a, box }); continue }
      if (a.flags & 2) continue
      const members = [a, ...children]
      const texts = members.filter(m => m.subtype === 'FreeText' && m.contents).map(m => m.contents)
      const picked = pickLabelAndGlyph(texts)
      const glyph = picked.glyph
      let label = picked.label
      if (isStamp && !label) label = cleanText(a.contents || a.stampName || '')
      const labelMember = picked.label ? members.find(m => m.subtype === 'FreeText' && cleanText(m.contents) === picked.label) : undefined
      const bounds = members.map(m => displayBounds(m, box))
      // the symbol is everything but the label text and the backing shape behind it
      const lb = labelMember ? displayBounds(labelMember, box) : null
      const symbol = members.filter(m => m !== labelMember && !(lb && overlapsMostly(displayBounds(m, box), lb))).map(m => displayBounds(m, box))
      const layer = members.map(m => m.layer).find(Boolean) ?? ''
      const subject = a.subject || a.stampName || ''
      out.candidates.push({
        id: a.ref ?? `p${page}-${out.candidates.length}`, page, kind: isStamp ? 'stamp' : 'group',
        bbox: union(bounds), symbolBox: union(symbol.length ? symbol : bounds), layer, label, glyph, subject,
        signature: signatureOf(layer, label, subject), members: members.map(m => m.ref ?? ''),
        hasImage: members.some(m => m.hasImage), annots: members, box,
      })
    }
  }
  out.skipped = Math.max(0, total - kept)
  return out
}

/** Distinct signatures with their candidates, most frequent first. */
export interface RevuSignature { signature: string; layer: string; label: string; subject: string; candidates: RevuCandidate[] }

export function groupSignatures(cands: RevuCandidate[]): RevuSignature[] {
  const map = new Map<string, RevuSignature>()
  for (const c of cands) {
    const s = map.get(c.signature)
    if (s) s.candidates.push(c)
    else map.set(c.signature, { signature: c.signature, layer: c.layer, label: c.label, subject: c.subject, candidates: [c] })
  }
  return [...map.values()].sort((a, b) => b.candidates.length - a.candidates.length || a.signature.localeCompare(b.signature))
}

// ---- mapping to our catalog ----

export type MappingAction = 'device' | 'plain' | 'skip'
export interface RevuMapping {
  signature: string
  action: MappingAction
  symbol_set_id: string | null
  device_type_id: string | null
  product_id: string | null
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export interface SuggestCatalog {
  sets: { id: string; name: string }[]
  types: { id: string; symbol_set_id: string; name: string; tag_prefix: string | null }[]
}

/** Suggested target for a signature: type by label prefix = tag_prefix, set by fuzzy layer name. */
export function suggestMapping(sig: Pick<RevuSignature, 'signature' | 'layer' | 'label'>, cat: SuggestCatalog): RevuMapping {
  const none: RevuMapping = { signature: sig.signature, action: 'device', symbol_set_id: null, device_type_id: null, product_id: null }
  const prefix = labelPrefix(sig.label)
  const layer = norm(sig.layer)
  let set = layer ? cat.sets.find(s => norm(s.name) === layer) : undefined
  if (!set && layer.length >= 3) set = cat.sets.find(s => { const n = norm(s.name); return n.includes(layer) || layer.includes(n) })
  if (!set && layer.length >= 4) set = cat.sets.find(s => { const n = norm(s.name); return n.length >= 4 && (n.startsWith(layer.slice(0, 4)) || layer.startsWith(n.slice(0, 4))) })
  const hasPrefix = (t: SuggestCatalog['types'][number]) => (t.tag_prefix ?? '').toUpperCase() === prefix
  const type = prefix
    ? (set ? cat.types.find(t => t.symbol_set_id === set!.id && hasPrefix(t)) : undefined) ?? cat.types.find(hasPrefix)
    : undefined
  if (type) return { ...none, symbol_set_id: type.symbol_set_id, device_type_id: type.id }
  if (set) return { ...none, symbol_set_id: set.id }
  return none
}

// ---- building the import ----

export interface RevuPlanContext {
  documentId: string
  catalog: Catalog
  /** Mapping by signature. Signatures without one are skipped. */
  mappings: Map<string, RevuMapping>
  /** Custom layer id by Revu layer name (create them first, see `plainLayerNames`). */
  layerIds?: Map<string, string>
  /** Device size in page points (default 24). */
  deviceSize?: number
  /** Size devices from the Revu symbol box instead. */
  useBboxSize?: boolean
  newId?: () => string
  /** false imports only the devices. */
  includePlain?: boolean
}

export interface RevuPlan {
  changes: Change
  devices: number
  markups: number
  /** Annotations not imported (links, hidden, unsupported). */
  skipped: number
  /** Groups skipped through the "Skip" choice or a missing mapping. */
  skippedDevices: number
  byType: Record<string, number>
  /** Devices created per signature. */
  perSignature: Record<string, number>
}

export const DEFAULT_DEVICE_SIZE = 24

/** Custom layer names the plain markups of this extraction (and plain-mapped groups) need. */
export function plainLayerNames(ex: RevuExtract, mappings?: Map<string, RevuMapping>): string[] {
  const names = new Set<string>()
  const add = (a: RawAnnot) => { if (a.layer && !(a.flags & 2)) names.add(a.layer) }
  for (const { annot } of ex.others) add(annot)
  for (const c of ex.candidates) if (mappings?.get(c.signature)?.action === 'plain') c.annots.forEach(add)
  return [...names]
}

/** Builds one undoable change: devices for mapped groups, plain markups for the rest. */
export function buildRevuPlan(ex: RevuExtract, ctx: RevuPlanContext): RevuPlan {
  const newId = ctx.newId ?? uuid
  const plan: RevuPlan = { changes: [], devices: 0, markups: 0, skipped: ex.skipped, skippedDevices: 0, byType: {}, perSignature: {} }
  const count = (t: string) => { plan.byType[t] = (plan.byType[t] ?? 0) + 1 }
  const plain = (a: RawAnnot, box: PageBox) => {
    if (a.flags & 2) { plan.skipped++; return }
    const mapped = mapAnnotation(a, box)
    if (!mapped.length) { plan.skipped++; return }
    for (const m of mapped) {
      plan.changes.push({ before: null, after: {
        id: newId(), document_id: ctx.documentId, page: m.page, type: m.type, geometry: m.geometry, style: m.style, text: m.text,
        layer_id: (a.layer && ctx.layerIds?.get(a.layer)) || null,
      } })
      plan.markups++
      count(m.type)
    }
  }
  const size = ctx.deviceSize ?? DEFAULT_DEVICE_SIZE
  for (const c of ex.candidates) {
    const map = ctx.mappings.get(c.signature)
    if (!map || map.action === 'skip' || (map.action === 'device' && !map.symbol_set_id)) { plan.skippedDevices++; continue }
    if (map.action === 'plain') {
      if (ctx.includePlain !== false) for (const a of c.annots) plain(a, c.box)
      continue
    }
    const b = ctx.useBboxSize ? c.symbolBox : null
    const side = b ? Math.max(8, Math.min(b[2] - b[0], b[3] - b[1])) : size
    const cx = (c.symbolBox[0] + c.symbolBox[2]) / 2, cy = (c.symbolBox[1] + c.symbolBox[3]) / 2
    const product = map.product_id ? ctx.catalog.products.get(map.product_id) : undefined
    const device: Markup = {
      id: newId(), document_id: ctx.documentId, page: c.page, type: 'device',
      geometry: { x: cx - side / 2, y: cy - side / 2, width: side, height: side, rotation: 0 },
      style: { ...DEFAULT_STYLE }, text: '', layer_id: null,
      symbol_set_id: map.symbol_set_id, device_type_id: map.device_type_id, product_id: map.product_id,
      tag: '', status: 'planned',
      fields: { ...productFields(product), ...(c.label ? { revu_code: c.label } : {}) },
    }
    plan.changes.push({ before: null, after: device })
    plan.devices++
    plan.perSignature[c.signature] = (plan.perSignature[c.signature] ?? 0) + 1
    count('device')
  }
  if (ctx.includePlain !== false) for (const { annot, box } of ex.others) plain(annot, box)
  return plan
}
