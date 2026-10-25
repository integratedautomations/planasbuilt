import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE } from '../markups/types'
import type { BoxGeometry, Markup, SymbolSet } from '../markups/types'
import { approxTextWidth, buildAnnot } from './annots'
import { sanitizeMarkup } from './importMap'

const set: SymbolSet = { id: 's1', name: 'Cameras', color: '#1971c2', tag_prefix: 'CAM', icon: '', fields: [], has_fov: false, sort: 0 }
const pbox = { llx: 0, lly: 0, width: 612, height: 792, rotation: 0 }
const device = (geom: Partial<BoxGeometry> = {}): Markup => ({
  id: 'd1', document_id: 'doc', page: 1, type: 'device', text: '', layer_id: null, symbol_set_id: 's1', tag: 'CAM-01',
  style: { ...DEFAULT_STYLE }, geometry: { x: 100, y: 100, width: 24, height: 24, rotation: 0, ...geom },
})
const stream = (m: Markup, typeMount?: 'ceiling' | 'wall' | 'square') =>
  buildAnnot(m, { box: pbox, ppf: null, set, textWidth: approxTextWidth, typeMount })!.ap.stream
const count = (s: string, op: string) => s.split('\n').filter(l => l.endsWith(` ${op}`)).length

describe('device mount in exported PDFs', () => {
  it('draws the circle with curves, the wall D and the square as polygons', () => {
    const ceiling = stream(device())
    const wall = stream(device({ mount: 'wall' }))
    const square = stream(device({ mount: 'square' }))
    expect(count(ceiling, 'c')).toBeGreaterThanOrEqual(4)
    expect(count(wall, 'l')).toBeGreaterThan(count(ceiling, 'l') + 30)
    expect(count(square, 'l')).toBeGreaterThan(count(ceiling, 'l') + 20)
    expect(count(wall, 'c')).toBeLessThan(count(ceiling, 'c'))
    expect(wall).not.toEqual(ceiling)
    expect(square).not.toEqual(wall)
  })
  it("uses the device type's mount, and the device's own mount overrides it", () => {
    expect(stream(device(), 'wall')).toEqual(stream(device({ mount: 'wall' })))
    expect(stream(device({ mount: 'ceiling' }), 'wall')).toEqual(stream(device()))
    expect(stream(device({ mount: 'square' }), 'wall')).toEqual(stream(device({ mount: 'square' })))
  })
  it('turns the flat side with the coverage direction', () => {
    const east = stream(device({ mount: 'wall', fov: { direction: 0, angle: 90, range: 50 } }))
    const west = stream(device({ mount: 'wall', fov: { direction: 180, angle: 90, range: 50 } }))
    expect(east).not.toEqual(west)
  })
})

describe('importing a device keeps its mount override', () => {
  const geom = { x: 1, y: 2, width: 24, height: 24, rotation: 0 }
  const base = { id: 'm1', document_id: 'd', page: 1, type: 'device', style: DEFAULT_STYLE, text: '', layer_id: null }
  it('keeps valid values and drops invalid ones', () => {
    expect((sanitizeMarkup({ ...base, geometry: { ...geom, mount: 'wall' } })!.geometry as BoxGeometry).mount).toBe('wall')
    expect((sanitizeMarkup({ ...base, geometry: { ...geom, mount: 'floor' } })!.geometry as BoxGeometry).mount).toBeUndefined()
    expect((sanitizeMarkup({ ...base, geometry: geom })!.geometry as BoxGeometry).mount).toBeUndefined()
  })
})

describe('coverage cone in exported PDFs', () => {
  it('is drawn in page space even when the device is rotated', () => {
    const fov = { direction: -90, angle: 90, range: 60 }
    const plain = buildAnnot(device({ fov }), { box: pbox, ppf: null, set, textWidth: approxTextWidth })!
    const rotated = buildAnnot(device({ fov, rotation: 90 }), { box: pbox, ppf: null, set, textWidth: approxTextWidth })!
    expect(plain.ap.gstates.GC).toBeDefined()
    expect(rotated.ap.gstates.GC).toBeDefined()
    // the annotation rect covers the cone, i.e. it is much bigger than the 24pt device
    expect(plain.rect[2] - plain.rect[0]).toBeGreaterThan(40)
    expect(buildAnnot(device({ fov }), { box: pbox, ppf: null, set, textWidth: approxTextWidth, showCones: false })!.ap.gstates.GC).toBeUndefined()
  })
})
