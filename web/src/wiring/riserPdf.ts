// Riser diagram as PDF pages (pdf-lib), tabloid landscape, drawn from the same layout as the on-screen view. Used for the standalone
// download and as an optional section of the as-built report.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont, PDFPage } from 'pdf-lib'
import type { Catalog } from '../catalog/catalog'
import type { CableSettings } from '../markups/cables'
import type { Markup, SymbolSet } from '../markups/types'
import { hexToRgb, sanitizeText } from '../pdfio/stream'
import { buildWiring } from './graph'
import type { Wiring } from './graph'
import { badgePath, layoutRiser } from './layout'
import type { Prim, RiserPage } from './layout'

export const TABLOID = { w: 1224, h: 792 } // 17 x 11 in landscape

export interface RiserInput {
  projectName: string
  date: Date
  /** Every markup of the project (devices and cables are used). */
  markups: Markup[]
  symbolSets: Map<string, SymbolSet>
  catalog: Catalog
  docNames: Map<string, string>
  scaleFor: (documentId: string, page: number) => number | null
  defaults: CableSettings
  /** PNG icons keyed by set id and `type:<id>` (see pdfio/icons.loadIcons). */
  icons?: Map<string, Uint8Array>
}

export function wiringOf(i: RiserInput): Wiring {
  return buildWiring(i.markups, {
    symbolSets: i.symbolSets, types: i.catalog.types, cableTypes: i.catalog.cableTypes, docNames: i.docNames, scaleFor: i.scaleFor, defaults: i.defaults,
  })
}

/** Pages of the riser for a project (no PDF yet): what the PDF and the on-screen view both draw. */
export function riserPages(i: RiserInput, qa = true): RiserPage[] {
  return layoutRiser(wiringOf(i), { pageW: TABLOID.w, pageH: TABLOID.h, title: `${i.projectName} - Wiring riser`, qa })
}

const col = (hex: string | undefined, fallback = rgb(0.3, 0.3, 0.3)) => {
  const c = hexToRgb(hex)
  return c ? rgb(c[0], c[1], c[2]) : fallback
}

/** Draws prepared pages onto `doc`. */
export async function drawRiserPages(doc: PDFDocument, pages: RiserPage[], icons?: Map<string, Uint8Array>): Promise<number> {
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()
  const iconFor = async (p: Extract<Prim, { k: 'badge' }>) => {
    const key = icons?.has(`type:${p.typeId}`) ? `type:${p.typeId}` : icons?.has(p.setId) ? p.setId : ''
    if (!key) return null
    if (!images.has(key)) { try { images.set(key, await doc.embedPng(icons!.get(key)!)) } catch { return null } }
    return images.get(key) ?? null
  }
  for (const pg of pages) {
    const page = doc.addPage([pg.width, pg.height])
    const Y = (y: number) => pg.height - y
    for (const p of pg.prims) await drawPrim(page, p, Y, font, bold, iconFor)
  }
  return pages.length
}

async function drawPrim(page: PDFPage, p: Prim, Y: (y: number) => number, font: PDFFont, bold: PDFFont, iconFor: (p: Extract<Prim, { k: 'badge' }>) => Promise<Awaited<ReturnType<PDFDocument['embedPng']>> | null>) {
  switch (p.k) {
    case 'rect':
      page.drawRectangle({ x: p.x, y: Y(p.y + p.h), width: p.w, height: p.h, ...(p.fill ? { color: col(p.fill) } : {}), ...(p.stroke ? { borderColor: col(p.stroke), borderWidth: 1 } : {}) })
      break
    case 'line':
      for (let i = 0; i + 3 < p.pts.length; i += 2)
        page.drawLine({ start: { x: p.pts[i], y: Y(p.pts[i + 1]) }, end: { x: p.pts[i + 2], y: Y(p.pts[i + 3]) }, thickness: p.w ?? 1, color: col(p.color), ...(p.dash ? { dashArray: [4, 3] } : {}) })
      break
    case 'text': {
      const f = p.bold ? bold : font
      const text = sanitizeText(p.text)
      let x = p.x
      if (p.anchor === 'end' || p.anchor === 'middle') {
        let w: number
        try { w = f.widthOfTextAtSize(text, p.size) } catch { w = text.length * p.size * 0.55 }
        x = p.anchor === 'end' ? p.x - w : p.x - w / 2
      }
      page.drawText(text, { x, y: Y(p.y), size: p.size, font: f, color: col(p.color, rgb(0, 0, 0)) })
      break
    }
    case 'badge': {
      page.drawSvgPath(badgePath(p.mount, p.r), { x: p.x, y: Y(p.y), color: col(p.color), borderColor: rgb(1, 1, 1), borderWidth: 0.8 })
      const img = await iconFor(p)
      if (img) { const s = p.r * 1.24; page.drawImage(img, { x: p.x - s / 2, y: Y(p.y) - s / 2, width: s, height: s }) }
      break
    }
    case 'hit':
      break
  }
}

/** The standalone riser PDF. */
export async function buildRiserPdf(i: RiserInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  await drawRiserPages(doc, riserPages(i), i.icons)
  return doc.save()
}

export function riserFileName(projectName: string, now = new Date()): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Project'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${safe} - Wiring riser - ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.pdf`
}
