import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib'
import type { PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildCatalog } from '../catalog/catalog'
import {
  buildRevuPlan, extractRevu, groupSignatures, labelPrefix, pickLabelAndGlyph, plainLayerNames, signatureOf, suggestMapping,
} from './revu'
import type { RevuMapping } from './revu'

/** A page with Revu-like groups: root Square + inner Square + backing Square + glyph and label FreeText, on layers. */
async function fixture() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([600, 800])
  const ctx = doc.context
  const layers = new Map<string, PDFRef>()
  const layer = (name: string) => {
    if (!layers.has(name)) layers.set(name, ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText(name) })))
    return layers.get(name)!
  }
  const refs: PDFRef[] = []
  const add = (d: Record<string, unknown>) => { const r = ctx.register(ctx.obj(d as never)); refs.push(r); return r }
  const base = (subtype: string, rect: number[], lyr: string, extra: Record<string, unknown> = {}) => ({
    Type: 'Annot', Subtype: subtype, Rect: rect, OC: layer(lyr), Subj: PDFHexString.fromText(subtype === 'FreeText' ? 'Text Box' : 'Rectangle'), ...extra,
  })
  const group = (x: number, y: number, lyr: string, label: string, glyph: string, subj = 'Rectangle') => {
    const root = add({ ...base('Square', [x, y, x + 20, y + 25], lyr), Subj: PDFHexString.fromText(subj) })
    const child = (d: Record<string, unknown>) => add({ ...d, IRT: root, RT: PDFName.of('Group') })
    child(base('Square', [x + 2, y + 3, x + 18, y + 23], lyr))
    child(base('Square', [x, y - 12, x + 20, y], lyr)) // backing shape of the label
    child(base('FreeText', [x + 1, y - 11, x + 19, y - 1], lyr, { Contents: PDFHexString.fromText(label + '\r') }))
    child(base('FreeText', [x + 3, y + 5, x + 17, y + 20], lyr, { Contents: PDFHexString.fromText(glyph) }))
    return root
  }
  group(100, 100, 'Fire', 'SD-1', 'S')
  group(200, 100, 'Fire', 'SD-1', 'S')
  group(300, 100, 'Cameras', 'OCAM-1', 'C')
  group(400, 100, 'Intercom', '7" ICM', 'I', 'Door Strike')
  // ungrouped plain markups and a link
  add(base('Line', [10, 10, 60, 60], 'Data', { L: [10, 10, 60, 60], C: [1, 0, 0] }))
  add(base('Square', [500, 500, 540, 540], 'Data', { C: [0, 0, 1] }))
  add({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 5, 5] })
  page.node.set(PDFName.of('Annots'), ctx.obj(refs))
  return PDFDocument.load(await doc.save())
}

describe('revu label helpers', () => {
  it('picks the label and glyph from the texts of a group', () => {
    expect(pickLabelAndGlyph(['S', 'SD-1\r'])).toEqual({ label: 'SD-1', glyph: 'S' })
    expect(pickLabelAndGlyph(['MD', 'MD-1'])).toEqual({ label: 'MD-1', glyph: 'MD' })
    expect(pickLabelAndGlyph(['I', '7" ICM'])).toEqual({ label: '7" ICM', glyph: 'I' })
    expect(pickLabelAndGlyph(['Some long note', 'W'])).toEqual({ label: 'Some long note', glyph: 'W' })
    expect(pickLabelAndGlyph(['G'])).toEqual({ label: '', glyph: 'G' })
  })
  it('builds signatures and prefixes', () => {
    expect(signatureOf('Fire', 'SD-1', 'Rectangle')).toBe('Fire | SD-1')
    expect(signatureOf('Fire', '', 'Door Strike')).toBe('Fire | Door Strike')
    expect(labelPrefix('M15-5')).toBe('M')
    expect(labelPrefix('OCAM-1')).toBe('OCAM')
    expect(labelPrefix('7" ICM')).toBe('')
  })
})

describe('extractRevu', () => {
  it('turns groups into candidates and leaves the rest as plain annotations', async () => {
    const ex = extractRevu(await fixture())
    expect(ex.candidates).toHaveLength(4)
    expect(groupSignatures(ex.candidates).map(s => [s.signature, s.candidates.length])).toEqual([
      ['Fire | SD-1', 2], ['Cameras | OCAM-1', 1], ['Intercom | 7" ICM', 1]])
    const c = ex.candidates[0]
    expect(c).toMatchObject({ page: 1, layer: 'Fire', label: 'SD-1', glyph: 'S', kind: 'group', subject: 'Rectangle' })
    expect(c.members).toHaveLength(5)
    // page is 800 high: the root (y 100..125) is display y 675..700, its label backing sits below (700..712)
    expect(c.bbox).toEqual([100, 675, 120, 712])
    expect(c.symbolBox).toEqual([100, 675, 120, 700])
    expect(ex.candidates[3].subject).toBe('Door Strike')
    expect(ex.others.map(o => o.annot.subtype)).toEqual(['Line', 'Square'])
    expect(ex.skipped).toBe(1) // the link
    expect(plainLayerNames(ex)).toEqual(['Data'])
  })
})

describe('suggestMapping', () => {
  const cat = {
    sets: [{ id: 's-fire', name: 'Fire Alarm' }, { id: 's-cam', name: 'Cameras' }, { id: 's-int', name: 'Intercom' }],
    types: [
      { id: 't-sd', symbol_set_id: 's-fire', name: 'Smoke detector', tag_prefix: 'SD' },
      { id: 't-ocam', symbol_set_id: 's-cam', name: 'Outdoor camera', tag_prefix: 'OCAM' },
    ],
  }
  it('matches the type by label prefix and the set by layer name', () => {
    expect(suggestMapping({ signature: 'Fire | SD-1', layer: 'Fire', label: 'SD-1' }, cat)).toMatchObject({ symbol_set_id: 's-fire', device_type_id: 't-sd', action: 'device' })
    expect(suggestMapping({ signature: 'x', layer: 'Cameras', label: 'OCAM-1' }, cat)).toMatchObject({ symbol_set_id: 's-cam', device_type_id: 't-ocam' })
    expect(suggestMapping({ signature: 'x', layer: 'Intercom', label: '7" ICM' }, cat)).toMatchObject({ symbol_set_id: 's-int', device_type_id: null })
    expect(suggestMapping({ signature: 'x', layer: 'Weird', label: 'ZZ-1' }, cat)).toMatchObject({ symbol_set_id: null, device_type_id: null })
  })
})

describe('buildRevuPlan', () => {
  const catalog = buildCatalog({
    device_types: [{ id: 't-sd', symbol_set_id: 's-fire', name: 'Smoke', icon: '', tag_prefix: 'SD', fields: [], default_product_id: 'p1', sort: 0 }],
    products: [{ id: 'p1', device_type_id: 't-sd', kind: 'device', manufacturer: 'Acme', model: 'SD100', name: '', spec_url: '', unit_cost: 1, labor_hours: 1, default_fields: {}, accessories: [], active: true }],
  })
  const mappings = (list: RevuMapping[]) => new Map(list.map(m => [m.signature, m]))
  let n = 0
  const newId = () => `id-${++n}`

  it('creates centered devices, imports the rest as plain markups, in one change', async () => {
    const ex = extractRevu(await fixture())
    const plan = buildRevuPlan(ex, {
      documentId: 'doc', catalog, newId, layerIds: new Map([['Data', 'layer-data']]),
      mappings: mappings([
        { signature: 'Fire | SD-1', action: 'device', symbol_set_id: 's-fire', device_type_id: 't-sd', product_id: 'p1' },
        { signature: 'Cameras | OCAM-1', action: 'skip', symbol_set_id: null, device_type_id: null, product_id: null },
        { signature: 'Intercom | 7" ICM', action: 'plain', symbol_set_id: null, device_type_id: null, product_id: null },
      ]),
    })
    expect(plan.devices).toBe(2)
    expect(plan.skippedDevices).toBe(1)
    const after = plan.changes.map(c => c.after!)
    const devices = after.filter(m => m.type === 'device')
    expect(devices).toHaveLength(2)
    expect(devices[0]).toMatchObject({
      page: 1, symbol_set_id: 's-fire', device_type_id: 't-sd', product_id: 'p1', tag: '',
      geometry: { width: 24, height: 24, rotation: 0 },
      fields: { manufacturer: 'Acme', model: 'SD100', revu_code: 'SD-1' },
    })
    // centered on the symbol box (x 100..120, y 675..700)
    const g = devices[0].geometry as { x: number; y: number }
    expect([g.x + 12, g.y + 12]).toEqual([110, 687.5])
    // plain markups: the line and square on layer Data, plus the annotations of the group mapped as plain
    const plain = after.filter(m => m.type !== 'device')
    expect(plain.filter(m => m.layer_id === 'layer-data').map(m => m.type)).toEqual(['line', 'rect'])
    expect(plan.markups).toBe(plain.length)
    expect(plain.length).toBeGreaterThan(2)
    expect(plan.perSignature).toEqual({ 'Fire | SD-1': 2 })
    expect(plan.changes.every(c => c.before === null)).toBe(true)
  })

  it('can size devices from the Revu symbol and skip plain markups', async () => {
    const ex = extractRevu(await fixture())
    const plan = buildRevuPlan(ex, {
      documentId: 'doc', catalog, newId, useBboxSize: true, includePlain: false,
      mappings: mappings([{ signature: 'Fire | SD-1', action: 'device', symbol_set_id: 's-fire', device_type_id: null, product_id: null }]),
    })
    expect(plan.markups).toBe(0)
    expect(plan.changes).toHaveLength(2)
    expect(plan.changes[0].after!.geometry).toMatchObject({ width: 20, height: 20 })
  })
})
