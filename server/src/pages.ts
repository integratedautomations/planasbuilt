import { PDFDocument, degrees } from 'pdf-lib'

/**
 * Page tools: pure page-number remapping (so markups, scales and areas can follow their pages)
 * plus the pdf-lib edits themselves.
 */

export type PageOp =
  /** `count` new pages are inserted so the first of them becomes page `at` (1..pageCount+1). */
  | { type: 'insert'; at: number; count: number }
  | { type: 'delete'; pages: number[] }
  /** order[i] = the old page that becomes page i+1; must be a permutation of 1..pageCount. */
  | { type: 'reorder'; order: number[] }
  | { type: 'rotate'; pages: number[]; degrees: number }
  /** The given pages' content is swapped for the uploaded PDF's first pages; markups stay on their page numbers. */
  | { type: 'replace'; pages: number[] }

export interface PageMapping {
  /** map[oldPage - 1] = new page number, or null when the page is gone. */
  map: (number | null)[]
  newCount: number
}

export class PageOpError extends Error {}

const isPage = (n: unknown, count: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= count

function uniquePages(pages: unknown, count: number): number[] {
  if (!Array.isArray(pages) || !pages.length) throw new PageOpError('Choose at least one page')
  const out = new Set<number>()
  for (const p of pages) {
    if (!isPage(p, count)) throw new PageOpError(`Page ${String(p)} does not exist (the plan has ${count})`)
    out.add(p)
  }
  return [...out].sort((a, b) => a - b)
}

/** Where each old page ends up. Throws PageOpError for an invalid operation. */
export function remapPages(op: PageOp, pageCount: number): PageMapping {
  const identity = Array.from({ length: pageCount }, (_, i) => i + 1)
  switch (op.type) {
    case 'insert': {
      if (!Number.isInteger(op.count) || op.count < 1) throw new PageOpError('Nothing to insert')
      if (!Number.isInteger(op.at) || op.at < 1 || op.at > pageCount + 1) throw new PageOpError(`Insert position must be 1 to ${pageCount + 1}`)
      return { map: identity.map(p => (p >= op.at ? p + op.count : p)), newCount: pageCount + op.count }
    }
    case 'delete': {
      const gone = new Set(uniquePages(op.pages, pageCount))
      if (gone.size >= pageCount) throw new PageOpError('A plan needs at least one page')
      let next = 0
      return { map: identity.map(p => (gone.has(p) ? null : ++next)), newCount: pageCount - gone.size }
    }
    case 'reorder': {
      if (!Array.isArray(op.order) || op.order.length !== pageCount || new Set(op.order).size !== pageCount || !op.order.every(p => isPage(p, pageCount)))
        throw new PageOpError('Reorder needs every page exactly once')
      const map: (number | null)[] = new Array(pageCount).fill(null)
      op.order.forEach((oldPage, i) => { map[oldPage - 1] = i + 1 })
      return { map, newCount: pageCount }
    }
    case 'rotate': {
      uniquePages(op.pages, pageCount)
      if (!Number.isInteger(op.degrees) || op.degrees % 90 !== 0 || op.degrees % 360 === 0) throw new PageOpError('Rotate by 90, 180 or 270 degrees')
      return { map: identity, newCount: pageCount }
    }
    case 'replace': {
      uniquePages(op.pages, pageCount)
      return { map: identity, newCount: pageCount }
    }
  }
}

export const isIdentity = (m: PageMapping) => m.map.every((n, i) => n === i + 1)

// ---------------------------------------------------------------- geometry

type Geo = { x: number; y: number; rotation?: number; points?: number[]; width?: number; height?: number; fov?: { direction: number; [k: string]: unknown } }

/**
 * Markup geometry after its page is turned clockwise by `deg` (90/180/270).
 * Markups live in displayed-page space (origin top-left, y down) with `w` x `h` the page size BEFORE the turn.
 * The whole plane rotates rigidly, so each shape's anchor moves and its own rotation (and cone direction) gain `deg`.
 */
export function rotateGeometry<G extends Geo>(g: G, deg: number, w: number, h: number): G {
  let out: Geo = { ...g }
  let cw = w, ch = h
  const steps = (((deg % 360) + 360) % 360) / 90
  for (let i = 0; i < steps; i++) {
    out = { ...out, x: ch - out.y, y: out.x, rotation: (((out.rotation ?? 0) + 90) % 360 + 360) % 360 }
    if (out.fov && typeof out.fov.direction === 'number') out.fov = { ...out.fov, direction: (out.fov.direction + 90) % 360 }
    ;[cw, ch] = [ch, cw]
  }
  return out as G
}

// ---------------------------------------------------------------- pdf edits

/** Displayed size (after /Rotate) of every page, in points. */
export function displaySizes(doc: PDFDocument): { width: number; height: number }[] {
  return doc.getPages().map(p => {
    const box = p.getCropBox()
    const r = ((p.getRotation().angle % 360) + 360) % 360
    return r === 90 || r === 270 ? { width: box.height, height: box.width } : { width: box.width, height: box.height }
  })
}

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { ignoreEncryption: true })

export interface PdfEditResult { bytes: Uint8Array; pageCount: number }

/** Applies `op` to a PDF. `other` is the uploaded PDF for insert / replace. */
export async function editPdf(src: Uint8Array, op: PageOp, other?: Uint8Array): Promise<PdfEditResult> {
  const doc = await load(src)
  const count = doc.getPageCount()
  remapPages(op, count) // validates
  switch (op.type) {
    case 'insert': {
      if (!other) throw new PageOpError('Upload the PDF to insert')
      const ins = await load(other)
      const pages = await doc.copyPages(ins, ins.getPageIndices())
      if (pages.length !== op.count) throw new PageOpError('The uploaded PDF changed while inserting')
      pages.forEach((p, i) => doc.insertPage(op.at - 1 + i, p))
      break
    }
    case 'delete':
      for (const p of [...new Set(op.pages)].sort((a, b) => b - a)) doc.removePage(p - 1)
      break
    case 'reorder': {
      const out = await PDFDocument.create()
      const pages = await out.copyPages(doc, op.order.map(p => p - 1))
      pages.forEach(p => out.addPage(p))
      return { bytes: await out.save(), pageCount: out.getPageCount() }
    }
    case 'rotate':
      for (const p of new Set(op.pages)) {
        const page = doc.getPage(p - 1)
        page.setRotation(degrees((((page.getRotation().angle + op.degrees) % 360) + 360) % 360))
      }
      break
    case 'replace': {
      if (!other) throw new PageOpError('Upload the replacement PDF')
      const pages = [...new Set(op.pages)].sort((a, b) => a - b)
      const rep = await load(other)
      if (rep.getPageCount() < pages.length) throw new PageOpError(`Replacing ${pages.length} page(s) needs a PDF with at least that many pages`)
      const copied = await doc.copyPages(rep, pages.map((_, i) => i))
      pages.forEach((p, i) => { doc.removePage(p - 1); doc.insertPage(p - 1, copied[i]) })
      break
    }
  }
  return { bytes: await doc.save(), pageCount: doc.getPageCount() }
}

/** Displayed size of every page of a PDF. */
export async function pageSizes(bytes: Uint8Array) {
  return displaySizes(await load(bytes))
}

/** Page count of an uploaded PDF (throws if it is not a readable PDF). */
export async function countPages(bytes: Uint8Array): Promise<number> {
  return (await load(bytes)).getPageCount()
}

/** "3", "2-4", "1,3,5-6" to sorted unique pages; null when malformed or when any page is beyond `count` (the real page count: a range is checked before it is expanded, never after). */
export function parsePageList(text: string, count: number): number[] | null {
  if (!Number.isInteger(count) || count < 1) return null
  const out = new Set<number>()
  for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!m) return null
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a || b > count) return null
    for (let p = a; p <= b; p++) out.add(p)
  }
  return out.size ? [...out].sort((x, y) => x - y) : null
}
