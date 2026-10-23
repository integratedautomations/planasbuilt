// Riser layout: turns a Wiring graph into drawing primitives on fixed-size pages (shared by the SVG view and the PDF). One column per
// hub, grouped by plan and page; devices are rows of mount badges with tag, cable type and length. Columns that are taller than a
// page continue on the next page, and a group's columns wrap onto further pages when they run out of width.
import type { Mount } from '../markups/mount'
import { formatLength } from '../units'
import { mountShape } from '../markups/mount'
import { NOT_CONNECTED_TEXT, problemText } from './graph'
import type { WHub, WLink, WNode, WRun, WRunItem, Wiring } from './graph'

export type Prim =
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; r?: number }
  | { k: 'text'; x: number; y: number; text: string; size: number; bold?: boolean; color?: string; anchor?: 'start' | 'middle' | 'end' }
  /** A polyline of x, y pairs. */
  | { k: 'line'; pts: number[]; color: string; w?: number; dash?: boolean }
  /** A mount-shaped badge centred at x, y with radius r. */
  | { k: 'badge'; x: number; y: number; r: number; mount: Mount; color: string; typeId: string; setId: string; deviceId?: string }
  /** Invisible clickable area over a device row. */
  | { k: 'hit'; x: number; y: number; w: number; h: number; deviceId: string }

export interface RiserPage { title: string; subtitle: string; width: number; height: number; prims: Prim[] }

export interface LayoutOpts {
  pageW: number
  pageH: number
  title: string
  margin?: number
  colW?: number
  gap?: number
  /** Add the "Not connected" pages. Default true. */
  qa?: boolean
}

export const ROW_H = 38, NOTE_H = 15, GAP_H = 8, HEAD_H = 66, TITLE_H = 58
const INK = '#212529', MUTED = '#6c757d', LINE = '#adb5bd'

/** Page path of the badge outline, centred on 0,0, as an SVG path (y down). */
export function badgePath(mount: Mount, r: number): string {
  const pts = mountShape(mount, r).outline
  let d = ''
  for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i].toFixed(2)} ${pts[i + 1].toFixed(2)} `
  return d + 'Z'
}

/** Shortens text to roughly fit `maxW` at `size` (an estimate: the renderers measure for real only when they need to). */
export function fit(text: string, size: number, maxW: number): string {
  const per = size * 0.52
  const max = Math.max(1, Math.floor(maxW / per))
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '...'
}

export const feetText = (ft: number | null): string => (ft === null ? '' : formatLength(ft))

const linkText = (l: WLink) => `${l.typeName || 'Cable'}${l.count > 1 ? ` x${l.count}` : ''}${l.parallel ? ` +${l.parallel}` : ''}`

type Row =
  | { kind: 'item'; item: WRunItem; pos: number; len: number; run: WRun }
  | { kind: 'note'; text: string }
  | { kind: 'gap' }
const rowH = (r: Row) => (r.kind === 'item' ? ROW_H : r.kind === 'note' ? NOTE_H : GAP_H)

function rowsOf(hub: WHub, tagOf: (id: string) => string): Row[] {
  const rows: Row[] = []
  hub.runs.forEach((run, i) => {
    if (i > 0) rows.push({ kind: 'gap' })
    if (run.from !== hub.node.id) rows.push({ kind: 'note', text: `Branch from ${tagOf(run.from)}` })
    run.items.forEach((item, pos) => rows.push({ kind: 'item', item, pos, len: run.items.length, run }))
    if (run.loopBack) rows.push({ kind: 'note', text: `Loop returns to ${hub.node.tag || 'hub'} (${linkText(run.loopBack)} ${feetText(run.loopBack.lengthFt)})`.replace(/ \)$/, ')') })
  })
  return rows
}

/** Splits rows into chunks no taller than `avail`; a chunk never ends on a note or gap. */
function chunk(rows: Row[], avail: number): Row[][] {
  const out: Row[][] = []
  let cur: Row[] = [], h = 0
  for (const r of rows) {
    if (cur.length && h + rowH(r) > avail) {
      // move trailing notes / gaps to the next chunk
      const carry: Row[] = []
      while (cur.length && cur[cur.length - 1].kind !== 'item') carry.unshift(cur.pop()!)
      out.push(cur)
      cur = carry.filter(c => c.kind === 'note')
      h = cur.reduce((s, c) => s + rowH(c), 0)
    }
    if (!(r.kind === 'gap' && cur.length === 0)) { cur.push(r); h += rowH(r) }
  }
  if (cur.some(r => r.kind === 'item') || out.length === 0) out.push(cur)
  return out
}

interface Placed { hub: WHub; x: number; headY: number; cont: boolean; last: boolean }

/** Lays the riser (and the Not connected pages) out on pages of `pageW` x `pageH` points. */
export function layoutRiser(w: Wiring, o: LayoutOpts): RiserPage[] {
  const margin = o.margin ?? 36, colW = o.colW ?? 190, gap = o.gap ?? 22
  const nodeTags = new Map<string, string>()
  for (const h of w.hubs) {
    nodeTags.set(h.node.id, h.node.tag)
    for (const r of h.runs) for (const i of r.items) nodeTags.set(i.node.id, i.node.tag)
  }
  const tagOf = (id: string) => nodeTags.get(id) || 'device'
  const groupOf = (n: WNode) => `${n.documentName || 'Plan'} - page ${n.page}`
  const depth = new Map<string, number>()
  for (const h of w.hubs) depth.set(h.node.id, h.uplink ? (depth.get(h.uplink.from.id) ?? 0) + 1 : 0)

  const groups = new Map<string, WHub[]>()
  for (const h of w.hubs) {
    const k = groupOf(h.node)
    const l = groups.get(k)
    if (l) l.push(h); else groups.set(k, [h])
  }
  const perPage = Math.max(1, Math.floor((o.pageW - 2 * margin + gap) / (colW + gap)))
  const bodyTop = margin + TITLE_H
  const avail = o.pageH - margin - bodyTop - HEAD_H - 16

  const pages: RiserPage[] = []
  const frame = (subtitle: string): RiserPage => {
    const p: RiserPage = { title: o.title, subtitle, width: o.pageW, height: o.pageH, prims: [] }
    pages.push(p)
    return p
  }

  for (const [label, hubs] of groups) {
    // every column chunk of the group, in order
    const chunks: { hub: WHub; rows: Row[]; cont: boolean; last: boolean }[] = []
    for (const hub of hubs) {
      const parts = chunk(rowsOf(hub, tagOf), avail)
      parts.forEach((rows, i) => chunks.push({ hub, rows, cont: i > 0, last: i === parts.length - 1 }))
    }
    for (let at = 0; at < chunks.length; at += perPage) {
      const slice = chunks.slice(at, at + perPage)
      const page = frame(label)
      const placed = new Map<string, Placed>()
      slice.forEach((c, i) => {
        const x = margin + i * (colW + gap)
        const y = bodyTop
        if (!c.cont) placed.set(c.hub.node.id, { hub: c.hub, x, headY: y, cont: false, last: c.last })
        drawColumn(page.prims, c.hub, c.rows, x, y, colW, c.cont, tagOf)
      })
      // hub-to-hub connectors between columns on this page
      for (const p of placed.values()) {
        const up = p.hub.uplink && placed.get(p.hub.uplink.from.id)
        if (!up || !p.hub.uplink) continue
        const lane = bodyTop - 8 - 5 * ((depth.get(p.hub.node.id) ?? 1) % 4)
        const ax = up.x + colW / 2, bx = p.x + colW / 2
        page.prims.push({ k: 'line', pts: [ax, up.headY, ax, lane, bx, lane, bx, p.headY], color: p.hub.uplink.link.color, w: 1.6 })
      }
    }
  }
  if (!pages.length) {
    const p = frame('')
    p.prims.push({ k: 'text', x: margin, y: bodyTop + 20, text: 'No cabled hubs yet. Draw cable runs between devices (end points snap to device centres) to build the riser.', size: 11, color: MUTED })
  }

  if (o.qa !== false) pages.push(...layoutQa(w, o))
  pages.forEach((p, i) => { p.subtitle = `${p.subtitle}${p.subtitle ? '   |   ' : ''}Sheet ${i + 1} of ${pages.length}` })
  // title block on every page
  for (const p of pages) {
    p.prims.unshift(
      { k: 'text', x: margin, y: margin + 14, text: p.title, size: 16, bold: true, color: INK },
      { k: 'text', x: margin, y: margin + 32, text: p.subtitle, size: 9, color: MUTED },
      { k: 'line', pts: [margin, margin + 40, p.width - margin, margin + 40], color: LINE, w: 0.8 },
    )
  }
  return pages
}

function drawColumn(prims: Prim[], hub: WHub, rows: Row[], x: number, y0: number, colW: number, cont: boolean, tagOf: (id: string) => string) {
  const n = hub.node
  prims.push({ k: 'rect', x, y: y0, w: colW, h: HEAD_H, fill: '#f1f3f5', stroke: n.color, r: 4 })
  prims.push({ k: 'badge', x: x + 24, y: y0 + 24, r: 16, mount: n.mount, color: n.color, typeId: n.typeId, setId: n.setId, deviceId: n.id })
  prims.push({ k: 'text', x: x + 48, y: y0 + 20, text: fit(`${n.tag || n.typeName}${cont ? ' (cont.)' : ''}`, 12, colW - 54), size: 12, bold: true, color: INK })
  prims.push({ k: 'text', x: x + 48, y: y0 + 33, text: fit(n.typeName, 8.5, colW - 54), size: 8.5, color: MUTED })
  if (hub.uplink) {
    const u = hub.uplink
    prims.push({ k: 'text', x: x + 8, y: y0 + 57, text: fit(`Uplink: ${u.from.tag || u.from.typeName} | ${linkText(u.link)} ${feetText(u.link.lengthFt)}`.trim(), 8, colW - 16), size: 8, color: u.link.color })
  } else {
    prims.push({ k: 'text', x: x + 8, y: y0 + 57, text: `${hub.runs.reduce((s, r) => s + r.items.length, 0)} device${hub.runs.reduce((s, r) => s + r.items.length, 0) === 1 ? '' : 's'}`, size: 8, color: MUTED })
  }
  prims.push({ k: 'hit', x, y: y0, w: colW, h: HEAD_H, deviceId: n.id })
  let y = y0 + HEAD_H + 8
  for (const r of rows) {
    if (r.kind === 'gap') { y += GAP_H; continue }
    if (r.kind === 'note') {
      prims.push({ k: 'text', x: x + 8, y: y + 11, text: fit(r.text, 8, colW - 14), size: 8, color: MUTED })
      y += NOTE_H
      continue
    }
    const it = r.item, node = it.node, l = it.link
    const cx = x + 22
    // chain line through the badges: a stub above, and one below unless this is the last device of the run
    prims.push({ k: 'line', pts: [cx, y, cx, y + 6], color: l.color, w: 1.6 })
    if (r.pos < r.len - 1) prims.push({ k: 'line', pts: [cx, y + ROW_H - 6, cx, y + ROW_H], color: l.color, w: 1.6 })
    prims.push({ k: 'badge', x: cx, y: y + ROW_H / 2, r: 12, mount: node.mount, color: node.color, typeId: node.typeId, setId: node.setId, deviceId: node.id })
    prims.push({ k: 'text', x: x + 42, y: y + 16, text: fit(node.tag || node.typeName, 10, colW - 42 - 78), size: 10, bold: true, color: INK })
    prims.push({ k: 'text', x: x + 42, y: y + 28, text: fit(node.typeName, 8, colW - 42 - 78), size: 8, color: MUTED })
    prims.push({ k: 'text', x: x + colW - 6, y: y + 16, text: fit(linkText(l), 8.5, 76), size: 8.5, color: l.color, anchor: 'end' })
    const len = feetText(l.lengthFt)
    const label = r.run.homeRun ? (len ? `HR | ${len}` : 'HR') : len || (r.pos === 0 ? 'to hub' : 'chain')
    prims.push({ k: 'text', x: x + colW - 6, y: y + 28, text: fit(label, 8.5, 76), size: 8.5, color: MUTED, anchor: 'end' })
    prims.push({ k: 'hit', x, y, w: colW, h: ROW_H, deviceId: node.id })
    y += ROW_H
  }
  void tagOf
}

/** The Not connected pages: devices with no cable (or none that reaches a hub), and cable runs with an open or free end. */
export function layoutQa(w: Wiring, o: LayoutOpts): RiserPage[] {
  const margin = o.margin ?? 36
  const devs = w.notConnected.devices, cables = w.notConnected.cables
  if (!devs.length && !cables.length) return []
  interface Line { text: string[]; bold?: boolean; gap?: boolean }
  const lines: Line[] = []
  if (devs.length) {
    lines.push({ text: [`Devices not connected (${devs.length})`], bold: true })
    for (const d of devs) lines.push({ text: [d.node.tag || '-', d.node.typeName, `${d.node.documentName} p${d.node.page}`, NOT_CONNECTED_TEXT[d.reason]] })
    lines.push({ text: [''], gap: true })
  }
  if (cables.length) {
    lines.push({ text: [`Cable runs with a problem (${cables.length})`], bold: true })
    for (const c of cables) lines.push({ text: [c.typeName || 'Cable', c.tags.join(', ') || '-', `${c.documentName} p${c.page}`, problemText(c)] })
  }
  const lineH = 14, top = margin + TITLE_H
  const per = Math.max(5, Math.floor((o.pageH - margin - top) / lineH))
  const colX = [margin, margin + 130, margin + 300, margin + 460]
  const pages: RiserPage[] = []
  for (let i = 0; i < lines.length; i += per) {
    const p: RiserPage = { title: o.title, subtitle: 'Not connected', width: o.pageW, height: o.pageH, prims: [] }
    lines.slice(i, i + per).forEach((l, j) => {
      const y = top + 12 + j * lineH
      if (l.bold) p.prims.push({ k: 'text', x: margin, y, text: l.text[0], size: 11, bold: true, color: INK })
      else if (!l.gap) l.text.forEach((t, c) => p.prims.push({ k: 'text', x: colX[c], y, text: fit(t, 9, (colX[c + 1] ?? o.pageW - margin) - colX[c] - 8), size: 9, color: c === 3 ? MUTED : INK }))
    })
    pages.push(p)
  }
  return pages
}
