import { describe, expect, it } from 'vitest'
import { pathFromPoints } from '../markups/geometry'
import type { Markup } from '../markups/types'
import { buildWiring } from './graph'
import type { WiringContext } from './graph'
import { badgePath, fit, layoutRiser, ROW_H } from './layout'
import type { Prim } from './layout'

const style = { stroke: '#e03131', fill: '', strokeWidth: 2, opacity: 1, fontSize: 12 }
const ctx: WiringContext = {
  symbolSets: new Map([['s', { id: 's', name: 'Network', color: '#7048e8', tag_prefix: 'N', icon: '', fields: [], has_fov: false, sort: 0 }]]),
  types: new Map([['sw', { name: 'Network Switch', mount: 'square' as const }], ['cam', { name: 'Camera', mount: 'ceiling' as const }]]),
  cableTypes: new Map([['c6', { id: 'c6', name: 'Cat6', color: '#1971c2', sort: 1 }]]),
  docNames: new Map([['d1', 'Floor 1'], ['d2', 'Floor 2']]), scaleFor: () => 10, defaults: { slackPct: 0, dropFt: 0 },
}
const dev = (id: string, tag: string, type: string, doc: string, x: number, y: number): Markup => ({
  id, tag, document_id: doc, page: 1, type: 'device', device_type_id: type, symbol_set_id: 's',
  geometry: { x: x - 12, y: y - 12, width: 24, height: 24, rotation: 0 }, style, text: '', layer_id: null,
})
const link = (a: Markup, b: Markup): Markup => ({
  id: `k-${a.id}-${b.id}`, document_id: a.document_id, page: 1, type: 'cable', style, text: '', layer_id: null, fields: { cable_type: 'c6' },
  geometry: { ...pathFromPoints([{ x: a.geometry.x + 12, y: a.geometry.y + 12 }, { x: b.geometry.x + 12, y: b.geometry.y + 12 }]), from: a.id, to: b.id },
})

/** `hubs` switches on `doc`, each with `leaves` cameras on a home run. */
function site(hubs: number, leaves: number, doc = 'd1', prefix = 'H'): Markup[] {
  const out: Markup[] = []
  for (let h = 0; h < hubs; h++) {
    const hub = dev(`${prefix}${h}`, `SW-${prefix}${h}`, 'sw', doc, 50 + h * 10, 50)
    out.push(hub)
    for (let l = 0; l < leaves; l++) {
      const c = dev(`${prefix}${h}-${l}`, `CAM-${prefix}${h}-${l}`, 'cam', doc, 100 + l * 10, 100 + h * 10)
      out.push(c, link(hub, c))
    }
  }
  return out
}

const TABLOID = { pageW: 1224, pageH: 792, title: 'Wiring riser' }
const inside = (p: Prim, w: number, h: number) => {
  const xs: number[] = [], ys: number[] = []
  if (p.k === 'line') p.pts.forEach((v, i) => (i % 2 ? ys : xs).push(v))
  else if (p.k === 'rect' || p.k === 'hit') { xs.push(p.x, p.x + p.w); ys.push(p.y, p.y + p.h) }
  else { xs.push(p.x); ys.push(p.y) }
  return xs.every(x => x >= 0 && x <= w) && ys.every(y => y >= 0 && y <= h)
}
const items = (pages: ReturnType<typeof layoutRiser>) => pages.flatMap(p => p.prims).filter(p => p.k === 'badge' && p.r === 12).length

describe('layoutRiser', () => {
  it('draws one column per hub with a row per device, all inside the page', () => {
    const w = buildWiring(site(3, 4), ctx)
    const pages = layoutRiser(w, TABLOID)
    expect(pages).toHaveLength(1)
    expect(items(pages)).toBe(12)
    expect(pages[0].prims.filter(p => p.k === 'badge' && p.r === 16)).toHaveLength(3) // hub headers
    for (const p of pages[0].prims) expect(inside(p, 1224, 792)).toBe(true)
    expect(pages[0].subtitle).toMatch(/Floor 1 - page 1/)
    expect(pages[0].subtitle).toMatch(/Sheet 1 of 1/)
  })

  it('splits a tall column across pages and wraps wide groups', () => {
    const w = buildWiring(site(1, 60), ctx)
    const pages = layoutRiser(w, TABLOID)
    expect(items(pages)).toBe(60) // every device exactly once
    const heads = pages.flatMap(p => p.prims).filter(p => p.k === 'text' && /cont\./.test(p.text))
    expect(heads.length).toBeGreaterThan(0)
    for (const pg of pages) for (const p of pg.prims) expect(inside(p, 1224, 792)).toBe(true)
    const many = layoutRiser(buildWiring(site(4, 60), ctx), TABLOID)
    expect(many.length).toBeGreaterThan(1)
    expect(items(many)).toBe(240)
    expect(many[many.length - 1].subtitle).toContain(`of ${many.length}`)
  })

  it('keeps each plan on its own pages', () => {
    const w = buildWiring([...site(1, 2, 'd1', 'A'), ...site(1, 2, 'd2', 'B')], ctx)
    const pages = layoutRiser(w, TABLOID)
    expect(pages.map(p => p.subtitle.split('   |')[0])).toEqual(['Floor 1 - page 1', 'Floor 2 - page 1'])
  })

  it('paginates the Not connected list', () => {
    const lonely = Array.from({ length: 80 }, (_, i) => dev(`L${i}`, `CAM-L${i}`, 'cam', 'd1', 500 + i, 500))
    const w = buildWiring([...site(1, 1), ...lonely], ctx)
    const pages = layoutRiser(w, TABLOID)
    const qa = pages.filter(p => p.subtitle.startsWith('Not connected'))
    expect(qa.length).toBeGreaterThan(1)
    const texts = qa.flatMap(p => p.prims).filter(p => p.k === 'text').map(p => (p as { text: string }).text)
    expect(texts.filter(t => /^CAM-L\d+$/.test(t))).toHaveLength(80)
    expect(layoutRiser(w, { ...TABLOID, qa: false }).some(p => p.subtitle.startsWith('Not connected'))).toBe(false)
  })

  it('draws a connector between hubs linked on the same page, and says so in the uplink line', () => {
    const a = dev('A', 'SW-A', 'sw', 'd1', 50, 50), b = dev('B', 'SW-B', 'sw', 'd1', 200, 50)
    const pages = layoutRiser(buildWiring([a, b, link(a, b)], ctx), TABLOID)
    const prims = pages[0].prims
    expect(prims.some(p => p.k === 'line' && p.pts.length === 8)).toBe(true)
    expect(prims.some(p => p.k === 'text' && /^Uplink: SW-A/.test(p.text))).toBe(true)
  })

  it('has a message instead of nothing when there are no cabled hubs', () => {
    const pages = layoutRiser(buildWiring([dev('x', 'X', 'cam', 'd1', 5, 5)], ctx), TABLOID)
    expect(pages[0].prims.some(p => p.k === 'text' && /No cabled hubs/.test(p.text))).toBe(true)
  })

  it('rows are ROW_H tall and helpers behave', () => {
    expect(ROW_H).toBeGreaterThan(30)
    expect(fit('abcdefghij', 10, 30)).toMatch(/\.\.\.$/)
    expect(fit('ab', 10, 100)).toBe('ab')
    expect(badgePath('square', 10)).toMatch(/^M.*Z$/)
  })
})
