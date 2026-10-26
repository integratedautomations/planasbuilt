import { describe, expect, it } from 'vitest'
import { pathFromPoints } from '../markups/geometry'
import type { Markup, PathGeometry } from '../markups/types'
import { buildWiring, isHubType, NOT_CONNECTED_TEXT, problemText } from './graph'
import type { WiringContext } from './graph'

const style = { stroke: '#e03131', fill: '', strokeWidth: 2, opacity: 1, fontSize: 12 }
const types = new Map([
  ['panel', { name: 'Fire Alarm Control Panel', mount: 'square' as const }],
  ['smoke', { name: 'Smoke Detector', mount: 'ceiling' as const }],
  ['sw', { name: 'Network Switch', mount: 'square' as const }],
  ['cam', { name: 'Dome Camera', mount: 'ceiling' as const }],
  ['mm', { name: 'Monitor Module', mount: 'square' as const }],
])
const ctx: WiringContext = {
  symbolSets: new Map([['fa', { id: 'fa', name: 'Fire Alarm', color: '#e03131', tag_prefix: 'FA', icon: '', fields: [], has_fov: false, sort: 0 }]]),
  types, cableTypes: new Map([['c6', { id: 'c6', name: 'Cat6', color: '#1971c2', sort: 1 }]]),
  docNames: new Map([['d1', 'Floor 1']]), scaleFor: () => 10, defaults: { slackPct: 0, dropFt: 0 },
}
let n = 0
const dev = (id: string, tag: string, type: string, x: number, y = 0, page = 1): Markup => ({
  id, tag, document_id: 'd1', page, type: 'device', device_type_id: type, symbol_set_id: 'fa',
  geometry: { x: x - 12, y: y - 12, width: 24, height: 24, rotation: 0 }, style, text: '', layer_id: null,
})
const cable = (a: Markup | null, b: Markup | null, extra: Partial<PathGeometry> = {}, typeId = 'c6'): Markup => {
  const pa = a ? { x: a.geometry.x + 12, y: a.geometry.y + 12 } : { x: 0, y: 500 }
  const pb = b ? { x: b.geometry.x + 12, y: b.geometry.y + 12 } : { x: 100, y: 500 }
  return { id: `c${++n}`, document_id: 'd1', page: 1, type: 'cable', style, text: '', layer_id: null, fields: { cable_type: typeId },
    geometry: { ...pathFromPoints([pa, pb]), ...(a ? { from: a.id } : {}), ...(b ? { to: b.id } : {}), ...extra } }
}

describe('hub classification', () => {
  it('square mounts and panel/controller/switch names are hubs; field modules are not', () => {
    expect(isHubType('Fire Alarm Control Panel', 'square')).toBe(true)
    expect(isHubType('Door Controller', 'ceiling')).toBe(true)
    expect(isHubType('Network Switch', 'wall')).toBe(true)
    expect(isHubType('NVR / Recorder', 'square')).toBe(true)
    expect(isHubType('Access Power Supply', 'square')).toBe(true)
    expect(isHubType('Smoke Detector', 'ceiling')).toBe(false)
    expect(isHubType('Monitor Module', 'square')).toBe(false)
    expect(isHubType('Waterflow Switch', 'square')).toBe(false)
    expect(isHubType('Light Switch', 'wall')).toBe(false)
  })
})

describe('buildWiring', () => {
  const P = dev('P', 'FACP-01', 'panel', 100)
  const S1 = dev('S1', 'SMK-01', 'smoke', 150), S2 = dev('S2', 'SMK-02', 'smoke', 200), S3 = dev('S3', 'SMK-03', 'smoke', 250)
  const SW1 = dev('SW1', 'SW-01', 'sw', 100, 100), SW2 = dev('SW2', 'SW-02', 'sw', 300, 100)
  const C1 = dev('C1', 'CAM-01', 'cam', 120, 200), C2 = dev('C2', 'CAM-02', 'cam', 160, 200)
  const lone = dev('L', 'CAM-09', 'cam', 900, 900)
  const devices = [P, S1, S2, S3, SW1, SW2, C1, C2, lone]

  it('puts a daisy chain under its hub in order, and a home run on its own', () => {
    const w = buildWiring([...devices, cable(P, S1), cable(S1, S2), cable(S2, S3), cable(SW1, C1)], ctx)
    const panel = w.hubs.find(h => h.node.id === 'P')!
    expect(panel.runs).toHaveLength(1)
    expect(panel.runs[0].items.map(i => i.node.tag)).toEqual(['SMK-01', 'SMK-02', 'SMK-03'])
    expect(panel.runs[0].homeRun).toBe(false)
    expect(panel.runs[0].items[1].from).toBe('S1')
    const sw = w.hubs.find(h => h.node.id === 'SW1')!
    expect(sw.runs[0].homeRun).toBe(true)
    expect(sw.runs[0].items[0].link).toMatchObject({ typeName: 'Cat6', lengthFt: expect.any(Number) })
  })

  it('home-run mode draws a star from the From device instead of a chain', () => {
    const run = cable(P, S3, { via: [{ id: 'S1', i: 1 }, { id: 'S2', i: 2 }] })
    run.geometry = { ...pathFromPoints([{ x: 100, y: 0 }, { x: 150, y: 0 }, { x: 200, y: 0 }, { x: 250, y: 0 }]), from: 'P', to: 'S3', via: [{ id: 'S1', i: 1 }, { id: 'S2', i: 2 }] }
    run.fields = { cable_type: 'c6', cable_mode: 'home' }
    const w = buildWiring([...devices, run], ctx)
    const panel = w.hubs.find(h => h.node.id === 'P')!
    expect(panel.runs).toHaveLength(3)
    expect(panel.runs.every(r => r.homeRun)).toBe(true)
    expect(panel.runs.map(r => r.items[0].link.lengthFt).sort((x, y) => x! - y!)).toEqual([5, 10, 15])
  })

  it('a chain ending back at the hub is a loop; a branch starts a new run', () => {
    const loop = buildWiring([P, S1, S2, S3, cable(P, S1), cable(S1, S2), cable(S2, S3), cable(S3, P)], ctx)
    expect(loop.hubs[0].runs).toHaveLength(1)
    expect(loop.hubs[0].runs[0].loopBack).not.toBeNull()
    const branch = buildWiring([P, S1, S2, S3, cable(P, S1), cable(S1, S2), cable(S1, S3)], ctx)
    expect(branch.hubs[0].runs).toHaveLength(2)
    expect(branch.hubs[0].runs[1].from).toBe('S1')
    expect(branch.hubs[0].runs[1].items[0].node.id).toBe('S3')
  })

  it('assigns a chain between two hubs to the nearer one', () => {
    const w = buildWiring([P, SW1, S1, S2, cable(P, S1), cable(S1, S2), cable(S2, SW1), cable(P, SW1)], ctx)
    const total = w.hubs.reduce((s, h) => s + h.runs.reduce((a, r) => a + r.items.length, 0), 0)
    expect(total).toBe(2)
  })

  it('draws hub-to-hub links as a tree rooted at the best connected hub', () => {
    const w = buildWiring([SW1, SW2, P, cable(SW1, SW2), cable(SW1, P)], ctx)
    expect(w.roots).toHaveLength(1)
    expect(w.roots[0].node.id).toBe('SW1')
    expect(w.roots[0].children.map(c => c.node.id).sort()).toEqual(['P', 'SW2'])
    expect(w.hubs[0].node.id).toBe('SW1')
    expect(w.roots[0].children[0].uplink?.from.id).toBe('SW1')
  })

  it('lists devices with no cable, cables with open or free ends, and chains that never reach a hub', () => {
    const open = cable(P, null, { open: ['to'] })
    const oneEnd = cable(S3, null)
    const free = cable(null, null)
    const orphanChain = [cable(C1, C2)]
    const w = buildWiring([...devices, cable(P, S1), open, oneEnd, free, ...orphanChain], ctx)
    const reasons = new Map(w.notConnected.devices.map(d => [d.node.id, d.reason]))
    expect(reasons.get('L')).toBe('no-cable')
    expect(reasons.get('S2')).toBe('no-cable')
    expect(reasons.get('C1')).toBe('no-hub')
    expect(reasons.get('C2')).toBe('no-hub')
    expect(reasons.has('S1')).toBe(false)
    expect(w.notConnected.cables.map(c => c.reason).sort()).toEqual(['no-ends', 'one-end', 'open-end'])
    expect(problemText(w.notConnected.cables.find(c => c.reason === 'open-end')!)).toMatch(/lost its device/)
    expect(NOT_CONNECTED_TEXT['no-hub']).toMatch(/not to a panel/)
  })

  it('a cable whose device was deleted shows as an open end, and a hub with no cable is only listed under Not connected', () => {
    const c = cable(P, S1)
    const w = buildWiring([P, c], ctx) // S1 is gone
    expect(w.notConnected.cables[0].reason).toBe('open-end')
    expect(w.hubs).toHaveLength(0)
    expect(w.notConnected.devices.map(d => d.node.id)).toEqual(['P'])
  })

  it('reports counts and length without a scale as null', () => {
    const w = buildWiring([P, S1, cable(P, S1)], { ...ctx, scaleFor: () => null })
    expect(w.hubs[0].runs[0].items[0].link.lengthFt).toBeNull()
    expect(w.counts).toMatchObject({ devices: 2, hubs: 1, cables: 1, connected: 2 })
  })
})
