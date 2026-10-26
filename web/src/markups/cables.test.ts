import { describe, expect, it } from 'vitest'
import { cableCount, cableColor, cableLength, cableTotals, danglingEnds, DEFAULT_CABLE_SETTINGS, endPoint, linkedEnds, nearestDevice, relinkEnds, setEnd, syncCables, viaAfterInsert, viaAfterRemove, viaOf, withVia, chainDevices, withLink } from './cables'
import { pathFromPoints } from './geometry'
import { pathPoints } from './snap'
import type { Markup, PathGeometry } from './types'
import { applyTo } from './useMarkups'
import type { Change } from './useMarkups'

const style = { stroke: '#e03131', fill: '', strokeWidth: 2, opacity: 1, fontSize: 12 }
const dev = (id: string, cx: number, cy: number, page = 1): Markup => ({
  id, document_id: 'd1', page, type: 'device', geometry: { x: cx - 12, y: cy - 12, width: 24, height: 24, rotation: 0 }, style, text: '', layer_id: null,
})
const cableOf = (id: string, pts: { x: number; y: number }[], links: Partial<PathGeometry> = {}, extra: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd1', page: 1, type: 'cable', geometry: { ...pathFromPoints(pts), ...links }, style, text: '', layer_id: null, ...extra,
})
const map = (...ms: Markup[]) => new Map(ms.map(m => [m.id, m]))
const move = (m: Markup, dx: number, dy: number): Markup => ({ ...m, geometry: { ...m.geometry, x: m.geometry.x + dx, y: m.geometry.y + dy } })
const abs = (m: Markup) => pathPoints(m.geometry as PathGeometry)
const near = (a: { x: number; y: number }, x: number, y: number) => { expect(a.x).toBeCloseTo(x, 6); expect(a.y).toBeCloseTo(y, 6) }

const A = dev('A', 100, 100), B = dev('B', 300, 200)

describe('linking', () => {
  it('locks an end that sits on a device centre and leaves a free end alone', () => {
    const g = pathFromPoints([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 200 }])
    const r = relinkEnds(g, map(A, B), 1)
    expect(r.from).toBe('A')
    expect(r.to).toBe('B')
    const half = relinkEnds(pathFromPoints([{ x: 100, y: 100 }, { x: 150, y: 150 }]), map(A, B), 1)
    expect(half.from).toBe('A')
    expect(half.to).toBeUndefined()
  })
  it('ignores devices on another page and finds the nearest device', () => {
    const far = dev('F', 100, 100, 2)
    expect(relinkEnds(pathFromPoints([{ x: 100, y: 100 }, { x: 5, y: 5 }]), map(far), 1).from).toBeUndefined()
    expect(nearestDevice([A, B], { x: 105, y: 100 }, 8)?.id).toBe('A')
    expect(nearestDevice([A, B], { x: 150, y: 100 }, 8)).toBeNull()
  })
  it('unlinks when an end is dragged away from its device and relinks when dragged onto another', () => {
    const c = cableOf('C', [{ x: 100, y: 100 }, { x: 300, y: 200 }], { from: 'A', to: 'B' })
    const away = setEnd(c.geometry as PathGeometry, 'to', { x: 250, y: 250 })
    const r = relinkEnds(away, map(A, B, c), 1)
    expect(r.to).toBeUndefined()
    expect(r.from).toBe('A')
    const A2 = dev('A2', 250, 250)
    const onto = relinkEnds(away, map(A, B, A2, c), 1)
    expect(onto.to).toBe('A2')
  })
  it('keeps a dangling marker through unrelated edits', () => {
    const g = withLink(pathFromPoints([{ x: 0, y: 0 }, { x: 50, y: 50 }]), 'from', null, true)
    expect(g.open).toEqual(['from'])
    expect(relinkEnds(g, map(A), 1).open).toEqual(['from'])
    expect(relinkEnds({ ...g, points: [...g.points.slice(0, 2), 60, 60] }, map(A), 1).open).toEqual(['from'])
  })
})

describe('cables follow devices', () => {
  const C = cableOf('C', [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 200 }], { from: 'A', to: 'B' })
  const all = map(A, B, C)

  it('moves the linked end with a device, in the same change', () => {
    const ch = syncCables([{ before: A, after: move(A, 20, 30) }], all)
    expect(ch).toHaveLength(2)
    const cc = ch.find(c => c.after?.id === 'C')!
    near(abs(cc.after!)[0], 120, 130)
    near(abs(cc.after!)[1], 200, 100) // middle point stays
    near(abs(cc.after!)[2], 300, 200)
    expect(cc.before).toBe(C)
    expect((cc.after!.geometry as PathGeometry).from).toBe('A')
  })

  it('handles a multi-select move of both devices (and of the cable too) without unlinking', () => {
    const both = syncCables([{ before: A, after: move(A, 10, 0) }, { before: B, after: move(B, 10, 0) }], all)
    const cc = both.find(c => c.after?.id === 'C')!.after!
    near(abs(cc)[0], 110, 100); near(abs(cc)[2], 310, 200)
    const rigid = syncCables([{ before: A, after: move(A, 10, 5) }, { before: B, after: move(B, 10, 5) }, { before: C, after: move(C, 10, 5) }], all)
    expect(rigid).toHaveLength(3)
    const rc = rigid.find(c => c.after?.id === 'C')!.after!
    expect(linkedEnds(rc, map(move(A, 10, 5), move(B, 10, 5)))).toEqual(['from', 'to'])
  })

  it('undo and redo restore every cable together with the device', () => {
    const change = syncCables([{ before: A, after: move(A, 40, 0) }], all)
    const moved = applyTo(all, change, 'forward')
    near(abs(moved.get('C')!)[0], 140, 100)
    const undone = applyTo(moved, change, 'back')
    expect(undone.get('C')).toBe(C)
    expect(undone.get('A')).toBe(A)
    const redone = applyTo(undone, change, 'forward')
    near(abs(redone.get('C')!)[0], 140, 100)
  })

  it('resizing a device about a different centre drags the end along', () => {
    const resized: Markup = { ...A, geometry: { x: 90, y: 90, width: 48, height: 48, rotation: 0 } } // centre (114, 114)
    const cc = syncCables([{ before: A, after: resized }], all).find(c => c.after?.id === 'C')!.after!
    near(abs(cc)[0], 114, 114)
  })

  it('does not touch cables of devices that did not move', () => {
    const ch: Change = [{ before: B, after: { ...B, tag: 'X' } }]
    expect(syncCables(ch, all)).toBe(ch)
  })

  it('deleting a device unlinks that end and marks it dangling; undo brings the link back', () => {
    const change = syncCables([{ before: A, after: null }], all)
    const cc = change.find(c => c.after?.id === 'C')!.after!
    const g = cc.geometry as PathGeometry
    expect(g.from).toBeUndefined()
    expect(g.open).toEqual(['from'])
    expect(g.to).toBe('B')
    const after = applyTo(all, change, 'forward')
    expect(danglingEnds(after.get('C')!, after)).toEqual(['from'])
    const back = applyTo(after, change, 'back')
    expect((back.get('C')!.geometry as PathGeometry).from).toBe('A')
    expect(danglingEnds(back.get('C')!, back)).toEqual([])
  })

  it('a device that leaves the page unlinks the end', () => {
    const g = syncCables([{ before: A, after: { ...A, page: 2 } }], all).find(c => c.after?.id === 'C')!.after!.geometry as PathGeometry
    expect(g.from).toBeUndefined()
    expect(g.open).toEqual(['from'])
  })

  it('a cable dragged away on its own unlinks both ends; a dragged end unlinks only that end', () => {
    const g = syncCables([{ before: C, after: move(C, 30, 30) }], all)[0].after!.geometry as PathGeometry
    expect(g.from).toBeUndefined(); expect(g.to).toBeUndefined()
    const edited = { ...C, geometry: setEnd(C.geometry as PathGeometry, 'to', { x: 350, y: 260 }) }
    const e = syncCables([{ before: C, after: edited }], all)[0].after!.geometry as PathGeometry
    expect(e.from).toBe('A'); expect(e.to).toBeUndefined()
  })

  it('a dangling reference that was already missing is reported but not rewritten', () => {
    const orphan = cableOf('O', [{ x: 0, y: 0 }, { x: 10, y: 10 }], { from: 'GONE' })
    const m = map(A, orphan)
    expect(danglingEnds(orphan, m)).toEqual(['from'])
    const ch: Change = [{ before: A, after: move(A, 1, 1) }]
    expect(syncCables(ch, m)).toBe(ch)
  })
})

describe('length math', () => {
  const ppf = 10 // 10 points per foot
  const C = cableOf('C', [{ x: 100, y: 100 }, { x: 300, y: 100 }], { from: 'A', to: 'B' }) // 200 pt = 20 ft drawn
  const byId = map(A, B, C)
  it('total = drawn x (1 + slack) + drop x linked ends, times count', () => {
    const len = cableLength(C, ppf, { slackPct: 10, dropFt: 5 }, byId)!
    expect(len.drawnFt).toBeCloseTo(20)
    expect(len.ends).toBe(2)
    expect(len.runFt).toBeCloseTo(20 * 1.1 + 10)
    expect(len.totalFt).toBeCloseTo(32)
    const multi = { ...C, fields: { cable_count: 3 } }
    expect(cableCount(multi)).toBe(3)
    expect(cableLength(multi, ppf, { slackPct: 10, dropFt: 5 }, byId)!.totalFt).toBeCloseTo(96)
  })
  it('counts drops only for linked ends and honours per-cable overrides', () => {
    const half = cableOf('H', [{ x: 100, y: 100 }, { x: 300, y: 100 }], { from: 'A' }, { fields: { cable_slack_pct: 0, cable_drop_ft: '2' } })
    const len = cableLength(half, ppf, DEFAULT_CABLE_SETTINGS, byId)!
    expect(len.ends).toBe(1)
    expect(len.slackPct).toBe(0)
    expect(len.runFt).toBeCloseTo(22)
    const dangling = cableOf('D', [{ x: 100, y: 100 }, { x: 300, y: 100 }], { from: 'GONE', open: ['to'] })
    expect(cableLength(dangling, ppf, { slackPct: 0, dropFt: 5 }, byId)!.ends).toBe(0)
  })
  it('has no length without a scale', () => {
    expect(cableLength(C, null, DEFAULT_CABLE_SETTINGS, byId)).toBeNull()
  })
  it('totals per cable type, with unscaled pages counted apart', () => {
    const types = new Map([['t6', { id: 't6', name: 'Cat6', color: '#1971c2', sort: 1 }]])
    const c1 = { ...C, id: 'c1', fields: { cable_type: 't6' } }
    const c2 = { ...C, id: 'c2', fields: { cable_type: 't6', cable_count: 2 } }
    const c3 = { ...C, id: 'c3', page: 2 }
    const rows = cableTotals([A, B, c1, c2, c3], (_d, page) => (page === 1 ? ppf : null), types, { slackPct: 0, dropFt: 0 })
    expect(rows.map(r => r.name)).toEqual(['Cat6', 'No type'])
    expect(rows[0]).toMatchObject({ cables: 2, runs: 3, unscaled: 0 })
    expect(rows[0].lengthFt).toBeCloseTo(20 + 40)
    expect(rows[1]).toMatchObject({ cables: 1, unscaled: 1, lengthFt: 0 })
  })
  it('draws in the cable type colour', () => {
    const types = new Map([['t6', { id: 't6', name: 'Cat6', color: '#1971c2', sort: 1 }]])
    expect(cableColor({ ...C, fields: { cable_type: 't6' } }, types)).toBe('#1971c2')
    expect(cableColor(C, types)).toBe('#e03131')
    expect(endPoint(C.geometry as PathGeometry, 'to')).toEqual({ x: 300, y: 100 })
  })
})

describe('via links (daisy chain)', () => {
  const A = dev('A', 0, 0), B = dev('B', 100, 0), C = dev('C', 200, 0), D = dev('D', 300, 0)
  const P = (x: number, y: number) => ({ x, y })
  const base = () => map(A, B, C, D)

  it('records intermediate devices with their vertex index when drawing', () => {
    const g = relinkEnds(pathFromPoints([P(0, 0), P(50, 30), P(100, 0), P(200, 0), P(300, 0)]), base(), 1)
    expect([g.from, g.to]).toEqual(['A', 'D'])
    expect(g.via).toEqual([{ id: 'B', i: 2 }, { id: 'C', i: 3 }])
  })
  it('leaves a run with no intermediate device without via', () => {
    const g = relinkEnds(pathFromPoints([P(0, 0), P(50, 50), P(300, 0)]), base(), 1)
    expect(g.via).toBeUndefined()
  })
  it('ignores devices on other pages', () => {
    expect(withVia(pathFromPoints([P(0, 0), P(100, 0), P(300, 0)]), base(), 2).via).toBeUndefined()
  })
  it('re-indexes on vertex insert and remove', () => {
    const g = { ...pathFromPoints([P(0, 0), P(100, 0), P(200, 0), P(300, 0)]), via: [{ id: 'B', i: 1 }, { id: 'C', i: 2 }] }
    expect(viaAfterInsert(g, 2).via).toEqual([{ id: 'B', i: 1 }, { id: 'C', i: 3 }])
    expect(viaAfterRemove(g, 1).via).toEqual([{ id: 'C', i: 1 }])
    expect(viaAfterRemove(g, 2).via).toEqual([{ id: 'B', i: 1 }])
  })
  it('moves the vertex with its device and restores both on undo', () => {
    const g = relinkEnds(pathFromPoints([P(0, 0), P(100, 0), P(300, 0)]), base(), 1)
    const cable = cableOf('c1', [{ x: 0, y: 0 }], {}, { geometry: g })
    const all = map(A, B, C, D, cable)
    const change = syncCables([{ before: B, after: move(B, 0, 40) }], all)
    expect(change).toHaveLength(2)
    const after = change[1].after as Markup
    near(abs(after)[1], 100, 40)
    expect((after.geometry as PathGeometry).via).toEqual([{ id: 'B', i: 1 }])
    const undone = applyTo(new Map(all), change, 'back')
    near(abs(undone.get('c1')!)[1], 100, 0)
  })
  it('drops the via link when its device is deleted, keeping the vertex', () => {
    const g = relinkEnds(pathFromPoints([P(0, 0), P(100, 0), P(300, 0)]), base(), 1)
    const cable = cableOf('c1', [{ x: 0, y: 0 }], {}, { geometry: g })
    const change = syncCables([{ before: B, after: null }], map(A, B, C, D, cable))
    const after = change.find(c => c.after?.id === 'c1')!.after as Markup
    expect((after.geometry as PathGeometry).via).toBeUndefined()
    expect(abs(after)).toHaveLength(3)
  })
  it('lists the chain in order', () => {
    const g = relinkEnds(pathFromPoints([P(0, 0), P(100, 0), P(300, 0)]), base(), 1)
    expect(chainDevices(g, base()).map(x => `${x.role}:${x.id}`)).toEqual(['from:A', 'via:B', 'to:D'])
    expect(viaOf(g)).toHaveLength(1)
  })
})

describe('via drop in the length formula', () => {
  const A = dev('A', 0, 0), B = dev('B', 100, 0), D = dev('D', 300, 0)
  const g = relinkEnds(pathFromPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 300, y: 0 }]), map(A, B, D), 1)
  const c = cableOf('c', [{ x: 0, y: 0 }], {}, { geometry: g })
  const all = map(A, B, D, c)
  it('adds one drop per passed-through device by default and drops it when the setting is off', () => {
    const on = cableLength(c, 10, { slackPct: 0, dropFt: 2 }, all)!
    expect(on.via).toBe(1)
    expect(on.runFt).toBeCloseTo(30 + 2 * 3, 6)
    expect(cableLength(c, 10, { slackPct: 0, dropFt: 2, viaDrop: false }, all)!.runFt).toBeCloseTo(30 + 2 * 2, 6)
  })
})
