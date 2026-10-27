import { PDFDocument, degrees, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { absolutePoints } from '../markups/areas'
import { DEFAULT_STYLE } from '../markups/types'
import type { BoxGeometry, Markup, PathGeometry, SymbolSet } from '../markups/types'
import { approxTextWidth, buildAnnot, contentsOf, scaleRatio } from './annots'
import { exportAnnotated, exportFlattened } from './build'
import { fromPdf } from './coords'
import { mapAnnotation } from './importMap'
import { planImport } from './importPlan'
import { readAnnotations } from './reader'
import type { PageBox } from './coords'

const DOC = 'doc-1'
let n = 0
const mk = (type: Markup['type'], geometry: Markup['geometry'], extra: Partial<Markup> = {}): Markup => ({
  id: `m-${++n}`, document_id: DOC, page: 1, type, geometry, text: '', layer_id: null,
  style: { ...DEFAULT_STYLE, stroke: '#1971c2', strokeWidth: 3 }, ...extra,
})
const box = (x: number, y: number, width: number, height: number, rotation = 0): BoxGeometry => ({ x, y, width, height, rotation })
const path = (x: number, y: number, points: number[]): PathGeometry => ({ x, y, rotation: 0, points })

const known = { layers: new Set<string>(), symbolSets: new Set(['s1']), deviceTypes: new Set<string>(), products: new Set<string>() }
const camSet: SymbolSet = { id: 's1', name: 'Cameras', color: '#1971c2', tag_prefix: 'CAM', icon: '', fields: [
  { key: 'ip', label: 'IP address', type: 'ip' }], has_fov: true, sort: 0 }

const samples = (): Markup[] => [
  mk('rect', box(100, 80, 120, 60), { style: { ...DEFAULT_STYLE, stroke: '#e03131', fill: '#ffd43b', strokeWidth: 4 } }),
  mk('ellipse', box(300, 120, 80, 50)),
  mk('cloud', box(50, 200, 150, 90)),
  mk('highlight', box(400, 300, 200, 30), { style: { ...DEFAULT_STYLE, stroke: '', fill: '#ffd43b', opacity: 0.4 } }),
  mk('text', box(60, 400, 220, 70), { text: 'Verify conduit routing with electrician', style: { ...DEFAULT_STYLE, fontSize: 16 } }),
  mk('line', path(10, 10, [0, 0, 100, 60])),
  mk('arrow', path(500, 60, [0, 0, -80, 90])),
  mk('polyline', path(200, 500, [0, 0, 50, 40, 120, 20, 160, 90])),
  mk('polygon', path(350, 450, [0, 0, 90, 10, 70, 80, 5, 60]), { style: { ...DEFAULT_STYLE, stroke: '#2f9e44', fill: '#2f9e44' } }),
  mk('freehand', path(420, 400, [0, 0, 5, 3, 12, 4, 20, 12, 33, 30])),
  mk('measure-length', path(100, 600, [0, 0, 144, 0])),
  mk('measure-polylength', path(100, 650, [0, 0, 72, 0, 72, 72])),
  mk('measure-area', path(300, 600, [0, 0, 144, 0, 144, 72, 0, 72])),
]

/** Absolute display-space vertices of any markup (boxes: corners). */
function absPts(m: Markup): [number, number][] {
  const g = m.geometry
  if ('points' in g) return absolutePoints(m).map(p => [p.x, p.y])
  return [[g.x, g.y], [g.x + g.width, g.y], [g.x + g.width, g.y + g.height], [g.x, g.y + g.height]]
}

async function blankPdf(rotation: number, crop?: [number, number, number, number]) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  if (rotation) page.setRotation(degrees(rotation))
  if (crop) page.setCropBox(...crop)
  return doc.save()
}

const input = (pdfBytes: Uint8Array, markups: Markup[], scales: Map<number, number> = new Map([[1, 72 / 8]])) => ({
  pdfBytes, markups, symbolSets: new Map([[camSet.id, camSet]]), scales,
})

describe('annotated export and import', () => {
  for (const [label, rotation, crop] of [
    ['unrotated', 0, undefined], ['rotated 90', 90, undefined], ['rotated 180', 180, undefined],
    ['rotated 270', 270, undefined], ['offset cropbox', 0, [20, 30, 500, 700] as [number, number, number, number]],
  ] as const) {
    it(`maps standard annotations back to the same geometry within 0.5pt (${label})`, async () => {
      const ms = samples()
      const out = await exportAnnotated(input(await blankPdf(rotation, crop), ms))
      const doc = await PDFDocument.load(out)
      const pages = readAnnotations(doc)
      expect(pages).toHaveLength(1)
      const { annots, box: pbox } = pages[0]
      expect(annots).toHaveLength(ms.length)
      // import as a foreign viewer would: ignore our private payload
      const mapped = annots.flatMap(a => mapAnnotation({ ...a, payload: undefined }, pbox))
      expect(mapped).toHaveLength(ms.length)
      ms.forEach((orig, i) => {
        const got = mapped[i]
        const expectedType = ({ cloud: 'cloud', highlight: 'highlight' } as Record<string, string>)[orig.type] ?? orig.type
        expect(got.type, orig.type).toBe(expectedType)
        const want = absPts(orig)
        const have = absPts({ ...orig, geometry: got.geometry })
        expect(have.length, orig.type).toBe(want.length)
        want.forEach(([x, y], k) => {
          expect(Math.abs(have[k][0] - x), `${orig.type} x[${k}]`).toBeLessThanOrEqual(0.5)
          expect(Math.abs(have[k][1] - y), `${orig.type} y[${k}]`).toBeLessThanOrEqual(0.5)
        })
      })
    })
  }

  it('restores the exact markup from the /PlanAsBuilt payload, keeping ids in the same document', async () => {
    const ms = samples()
    const out = await exportAnnotated(input(await blankPdf(0), ms))
    const plan = await planImport(out, { documentId: DOC, existing: new Map() })
    expect(plan.restored).toBe(ms.length)
    expect(plan.changes.map(c => c.after)).toEqual(ms)
    // re-importing into a document that already has them changes nothing
    const again = await planImport(out, { documentId: DOC, existing: new Map(ms.map(m => [m.id, m])) })
    expect(again.changes).toHaveLength(0)
    expect(again.unchanged).toBe(ms.length)
  })

  it('assigns new ids and clears tags when importing into another document', async () => {
    const dev = mk('device', box(200, 200, 28, 28, 45), {
      symbol_set_id: camSet.id, tag: 'CAM-01', status: 'installed', version: 4, created_by_name: 'Ann',
      fields: { ip: '10.0.0.5', model: 'X-100' },
    })
    const out = await exportAnnotated(input(await blankPdf(0), [dev]))
    let k = 0
    const plan = await planImport(out, { documentId: 'doc-2', existing: new Map(), newId: () => `new-${++k}`, known })
    const m = plan.changes[0].after!
    expect(m).toMatchObject({ id: 'new-1', document_id: 'doc-2', tag: '', type: 'device', status: 'installed', fields: { ip: '10.0.0.5', model: 'X-100' } })
    expect(m.version).toBeUndefined()
    expect(m.geometry).toEqual(dev.geometry)
  })

  it('updates an existing markup edited in the PDF', async () => {
    const orig = mk('rect', box(10, 10, 50, 50))
    const out = await exportAnnotated(input(await blankPdf(0), [{ ...orig, geometry: box(70, 10, 50, 50) }]))
    const plan = await planImport(out, { documentId: DOC, existing: new Map([[orig.id, orig]]) })
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0].before).toEqual(orig)
    expect((plan.changes[0].after!.geometry as BoxGeometry).x).toBe(70)
  })

  it('writes the standard keys Revu and Acrobat read', async () => {
    const [rect, , , , , , arrow, , , , len, , area] = samples()
    const out = await exportAnnotated(input(await blankPdf(0), [{ ...rect, created_by_name: 'Tzvi' }, arrow, len, area]))
    const doc = await PDFDocument.load(out)
    const annots = doc.getPages()[0].node.Annots()!
    const get = (i: number) => doc.context.lookup(annots.get(i)) as any
    const key = (d: any, k: string) => d.get(PDFName.of(k))
    expect(String(key(get(0), 'Subtype'))).toBe('/Square')
    expect(key(get(0), 'T').decodeText()).toBe('Tzvi')
    expect(key(get(0), 'NM').decodeText()).toBe(rect.id)
    expect(key(get(0), 'AP')).toBeDefined()
    expect(key(get(0), 'PlanAsBuilt')).toBeDefined()
    expect(String(key(get(1), 'Subtype'))).toBe('/Line')
    expect(String(key(get(1), 'LE'))).toContain('ClosedArrow')
    const measure = key(get(2), 'Measure')
    expect(String(key(get(2), 'IT'))).toBe('/LineDimension')
    expect(measure).toBeDefined()
    expect(((doc.context.lookup(measure) as any).get(PDFName.of('R')) as any).decodeText()).toBe('1 in = 8 ft')
    expect(String(key(get(3), 'IT'))).toBe('/PolygonDimension')
  })

  it('exports devices as stamps with a readable /Contents and keeps a cone inside the rect', async () => {
    const dev = mk('device', box(200, 200, 28, 28), {
      symbol_set_id: camSet.id, tag: 'CAM-01', status: 'tested', fields: { ip: '10.0.0.5', model: 'X-100' },
    })
    ;(dev.geometry as BoxGeometry).fov = { direction: 0, angle: 90, range: 100 }
    const spec = buildAnnot(dev, {
      box: { llx: 0, lly: 0, width: 612, height: 792, rotation: 0 }, ppf: null, set: camSet, textWidth: approxTextWidth,
    })!
    expect(spec.subtype).toBe('Stamp')
    expect(spec.contents).toBe(contentsOf(dev, camSet))
    expect(spec.contents).toBe('Tag: CAM-01 | IP: 10.0.0.5 | Model: X-100 | Status: Tested')
    expect(spec.subject).toBe('Cameras')
    expect(spec.rect[2]).toBeGreaterThan(300) // 214 center + 100 range
  })

  it('exports a radius measure as a Circle annotation with a scale and label', () => {
    const pbox = { llx: 0, lly: 0, width: 612, height: 792, rotation: 0 }
    const m = mk('measure-radius', path(100, 100, [0, 0, 40.5, 0]))
    const spec = buildAnnot(m, { box: pbox, ppf: 9, textWidth: approxTextWidth })!
    expect(spec.subtype).toBe('Circle')
    expect(spec.measure).toBeDefined()
    expect(spec.contents).toContain(`R 4'-6"`)
    expect(spec.inner![2] - spec.inner![0]).toBeCloseTo(81)
    const unscaled = buildAnnot(m, { box: pbox, ppf: null, textWidth: approxTextWidth })!
    expect(unscaled.measure).toBeUndefined()
  })

  it('does not turn unscaled measurements into dimensions', () => {
    const spec = buildAnnot(mk('measure-length', path(0, 0, [0, 0, 50, 0])), {
      box: { llx: 0, lly: 0, width: 612, height: 792, rotation: 0 }, ppf: null, textWidth: approxTextWidth })!
    expect(spec.intent).toBeUndefined()
    expect(spec.measure).toBeUndefined()
    expect(scaleRatio(9)).toBe('1 in = 8 ft')
  })

  it('imports third-party annotations (Highlight quads, FreeText, ink strokes) and counts the rest as skipped', () => {
    const pbox: PageBox = { llx: 0, lly: 0, width: 612, height: 792, rotation: 0 }
    const raw = (o: object) => ({ page: 1, rect: [0, 0, 10, 10], contents: '', author: '', name: '', subject: '', color: null, interior: null,
      opacity: 1, borderWidth: 1, flags: 4, ...o }) as any
    const hl = mapAnnotation(raw({ subtype: 'Highlight', color: [1, 1, 0], quadPoints: [100, 700, 200, 700, 100, 690, 200, 690] }), pbox)[0]
    expect(hl.type).toBe('highlight')
    expect(hl.geometry).toMatchObject({ x: 100, y: 792 - 700, width: 100, height: 10 })
    const ft = mapAnnotation(raw({ subtype: 'FreeText', rect: [50, 600, 150, 650], contents: 'Hello', da: '/Helv 14 Tf 1 0 0 rg' }), pbox)[0]
    expect(ft).toMatchObject({ type: 'text', text: 'Hello' })
    expect(ft.style.fontSize).toBe(14)
    expect(ft.style.stroke).toBe('#ff0000')
    expect(mapAnnotation(raw({ subtype: 'Ink', inkList: [[0, 0, 5, 5], [10, 10, 20, 20]] }), pbox)).toHaveLength(2)
    expect(mapAnnotation(raw({ subtype: 'Text' }), pbox)).toHaveLength(0)
    const pt = fromPdf(pbox, 0, 792)
    expect(pt).toEqual({ x: 0, y: 0 })
  })
})

describe('flattened export', () => {
  it('draws markups into the page and adds no annotations', async () => {
    const ms = samples()
    const base = await blankPdf(90)
    const out = await exportFlattened(input(base, ms))
    const doc = await PDFDocument.load(out)
    expect(doc.getPages()[0].node.Annots()?.size() ?? 0).toBe(0)
    expect(out.length).toBeGreaterThan(base.length + 2000)
    expect(readAnnotations(doc)[0].annots).toHaveLength(0)
  })
})

describe('Revu compatibility', () => {
  const pbox = { llx: 0, lly: 0, width: 612, height: 792, rotation: 0 }
  const squares = (a: number[][]) => a.flat()
  const room = (id: string, name: string, pts: number[]): Markup =>
    ({ ...mk('area', path(0, 0, pts), { text: name }), id })

  it('draws the text halo as a stroke-only pass before the coloured fill pass', () => {
    const dev = mk('device', box(200, 200, 28, 28), { symbol_set_id: camSet.id, tag: 'CAM-01' })
    const stream = buildAnnot(dev, { box: pbox, ppf: null, set: camSet, textWidth: approxTextWidth })!.ap.stream
    expect(stream).not.toMatch(/\b2 Tr\b/)
    const haloAt = stream.indexOf('1 Tr'), fillAt = stream.indexOf('0 Tr')
    expect(haloAt).toBeGreaterThan(-1)
    expect(fillAt).toBeGreaterThan(haloAt)
    expect(stream.slice(stream.lastIndexOf('BT', haloAt), haloAt)).toMatch(/1 1 1 RG\n[\d.]+ w\n1 j 1 J\n$/)
    expect(stream.slice(haloAt, fillAt)).toContain('Tj')
    expect(stream.slice(haloAt - 80, fillAt)).not.toMatch(/ rg\n1 Tr/)
  })

  it('exports calibrated areas as Revu area measurements and imports them back', async () => {
    const a = room('a1', 'Kitchen', [0, 0, 144, 0, 144, 72, 0, 72])
    const spec = buildAnnot(a, { box: pbox, ppf: 9, textWidth: approxTextWidth })!
    expect(spec).toMatchObject({ subtype: 'Polygon', intent: 'PolygonDimension', subject: 'Area', label: 'Kitchen' })
    expect(spec.measure?.ratio).toBe('1 in = 8 ft')
    expect(spec.contents).toMatch(/sq ?ft|SF/i)
    expect(buildAnnot(a, { box: pbox, ppf: null, textWidth: approxTextWidth })!.intent).toBeUndefined()
    const out = await exportAnnotated(input(await blankPdf(0), [a]))
    const d = (await PDFDocument.load(out)).getPages()[0].node.Annots()!
    const doc2 = await PDFDocument.load(out)
    const dict = doc2.context.lookup(doc2.getPages()[0].node.Annots()!.get(0)) as any
    expect(String(dict.get(PDFName.of('IT')))).toBe('/PolygonDimension')
    expect(dict.get(PDFName.of('Label')).decodeText()).toBe('Kitchen')
    expect(d.size()).toBe(1)
    const plan = await planImport(out, { documentId: DOC, existing: new Map() })
    expect(plan.changes[0].after).toEqual(a)
    const raw = readAnnotations(doc2)[0].annots[0]
    expect(mapAnnotation({ ...raw, payload: undefined }, pbox)[0].type).toBe('measure-area')
    void squares
  })

  it('maps device columns: Subject = type, Layer = set, Label = tag, Status and Location custom columns', async () => {
    const dev = mk('device', box(60, 60, 20, 20), { symbol_set_id: camSet.id, tag: 'CAM-02', status: 'tested', created_by_name: 'Ann' })
    const kitchen = room('a2', 'Kitchen', [0, 0, 200, 0, 200, 200, 0, 200])
    const spec = buildAnnot(dev, { box: pbox, ppf: null, set: camSet, typeName: 'Dome Camera', location: 'Kitchen', textWidth: approxTextWidth })!
    expect(spec).toMatchObject({ subject: 'Dome Camera', label: 'CAM-02', layerName: 'Cameras', author: 'Ann', columns: { Status: 'Tested', Location: 'Kitchen' } })
    expect(spec.contents).toContain('Tag: CAM-02')
    const out = await exportAnnotated(input(await blankPdf(0), [kitchen, dev]))
    const doc = await PDFDocument.load(out)
    const props = doc.context.lookup(doc.catalog.get(PDFName.of('OCProperties'))) as any
    expect(props.lookup(PDFName.of('OCGs')).size()).toBe(1)
    const pages = readAnnotations(doc)
    const raw = pages[0].annots.find(x => x.label === 'CAM-02')!
    expect(raw).toMatchObject({ layer: 'Cameras', label: 'CAM-02', columns: { Status: 'Tested', Location: 'Kitchen' } })
    // Revu edits come back: Label -> tag, Subject -> device type
    const tweaked = await planImport(out, { documentId: DOC, existing: new Map([[dev.id, dev], [kitchen.id, kitchen]]), known })
    expect(tweaked.unchanged).toBe(2)
    const imp = await planImport(out, { documentId: 'doc-9', existing: new Map(), newId: () => 'n' + ++n, known,
      typeIdByName: new Map(), setIdByName: new Map([['cameras', 's1']]) })
    expect(imp.changes.find(c => c.after!.type === 'device')!.after!.symbol_set_id).toBe('s1')
  })
})
