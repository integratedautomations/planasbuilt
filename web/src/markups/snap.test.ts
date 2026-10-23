import { describe, expect, it } from 'vitest'
import { SegIndex, buildMarkupIndex, handlePoints, lineAngle, snapHandles, snapOr, snapPoint } from './snap'
import type { SnapEnv } from './snap'
import { DEFAULT_SNAP, gridStep, normalizeSnap } from './snapConfig'
import type { SnapSettings } from './snapConfig'
import type { Markup } from './types'
import { DEFAULT_STYLE } from './types'

const mk = (id: string, type: Markup['type'], geometry: Markup['geometry']): Markup => ({
  id, document_id: 'd', page: 1, type, geometry, text: '', layer_id: null, style: { ...DEFAULT_STYLE },
})

const settings = (patch: Partial<SnapSettings> = {}): SnapSettings => ({ ...DEFAULT_SNAP, grid: true, ...patch })

function env(patch: Partial<SnapSettings> = {}, markups: Markup[] = [], pdfLines: number[] = [], step = 10): SnapEnv {
  return { settings: settings(patch), pdf: pdfLines.length ? SegIndex.fromSegments(pdfLines) : null, markups: buildMarkupIndex(markups), gridStep: step }
}

describe('snapPoint priorities', () => {
  // a device centre at (100,100), a polyline from (90,100)-(200,100), a PDF wall x = 100.5 from y 0 to 300
  const markups = [
    mk('dev', 'device', { x: 88, y: 88, width: 24, height: 24, rotation: 0 }),
    mk('pl', 'polyline', { x: 90, y: 100, rotation: 0, points: [0, 0, 110, 0] }),
  ]
  const wall = [100.5, 0, 100.5, 300]

  it('devices beat markup points, edges, PDF lines and grid', () => {
    const hit = snapPoint(env({}, markups, wall), { x: 103, y: 102 }, 1)
    expect(hit?.kind).toBe('device')
    expect(hit?.point).toEqual({ x: 100, y: 100 })
  })

  it('markup vertices and midpoints beat edges and PDF lines', () => {
    const e = env({ devices: false }, markups, wall)
    expect(snapPoint(e, { x: 92, y: 103 }, 1)?.kind).toBe('endpoint')
    const mid = snapPoint(e, { x: 146, y: 104 }, 1)
    expect(mid?.kind).toBe('midpoint')
    expect(mid?.point).toEqual({ x: 145, y: 100 })
    expect(mid?.angle).toBe(0)
  })

  it('markup edges beat PDF lines and report the edge angle', () => {
    const e = env({ devices: false }, markups, [160, 0, 160, 300])
    const hit = snapPoint(e, { x: 160, y: 104 }, 1)
    expect(hit?.kind).toBe('edge')
    expect(hit?.point).toEqual({ x: 160, y: 100 })
    expect(hit?.angle).toBe(0)
  })

  it('PDF corners beat points along a PDF segment, which beat the grid', () => {
    const lines = [50, 50, 150, 50, 150, 50, 150, 150]
    const e = env({}, [], lines)
    const corner = snapPoint(e, { x: 147, y: 53 }, 1)
    expect(corner?.kind).toBe('pdf')
    expect(corner?.end).toBe(true)
    expect(corner?.point).toEqual({ x: 150, y: 50 })
    const along = snapPoint(e, { x: 103, y: 54 }, 1)
    expect(along?.kind).toBe('pdf')
    expect(along?.end).toBeUndefined()
    expect(along?.point).toEqual({ x: 103, y: 50 })
    expect(along?.angle).toBe(0)
  })

  it('falls back to the grid, and to nothing outside the radius', () => {
    const e = env({}, [], [], 10)
    expect(snapPoint(e, { x: 52, y: 38 }, 1)).toMatchObject({ kind: 'grid', point: { x: 50, y: 40 } })
    expect(snapPoint(env({}, [], [], 100), { x: 150, y: 150 }, 1)).toBeNull() // 70 away from the nearest grid point
  })
})

describe('snap radius and zoom', () => {
  const lines = [0, 100, 200, 100]
  it('is 8 screen pixels: the page distance shrinks as you zoom in', () => {
    const e = env({ grid: false }, [], lines)
    expect(snapPoint(e, { x: 50, y: 107 }, 1)).not.toBeNull()
    expect(snapPoint(e, { x: 50, y: 109 }, 1)).toBeNull()
    expect(snapPoint(e, { x: 50, y: 101 }, 8)).not.toBeNull() // 1 pt = 8 px
    expect(snapPoint(e, { x: 50, y: 102 }, 8)).toBeNull()
    expect(snapPoint(e, { x: 50, y: 120 }, 0.25)).not.toBeNull() // 32 pt = 8 px
  })

  it('does not snap to a grid too dense to use', () => {
    expect(snapPoint(env({}, [], [], 1), { x: 5.2, y: 5.1 }, 1)).toBeNull() // 1 px apart
  })
})

describe('toggles', () => {
  const markups = [mk('dev', 'device', { x: 88, y: 88, width: 24, height: 24, rotation: 0 }), mk('r', 'rect', { x: 200, y: 200, width: 50, height: 50, rotation: 0 })]
  const lines = [300, 0, 300, 500]
  const p = (x: number, y: number) => ({ x, y })

  it('the master switch and Ctrl turn everything off', () => {
    expect(snapPoint(env({ on: false }, markups, lines), p(101, 101), 1)).toBeNull()
    expect(snapPoint(env({}, markups, lines), p(101, 101), 1, { off: true })).toBeNull()
    expect(snapOr(env({}, markups, lines), p(101, 101), 1, { off: true })).toEqual(p(101, 101))
  })

  it('each source can be switched off on its own', () => {
    expect(snapPoint(env({ devices: false, grid: false }, markups, lines), p(101, 101), 1)).toBeNull()
    expect(snapPoint(env({ markups: false, grid: false }, markups, lines), p(202, 202), 1)).toBeNull()
    expect(snapPoint(env({ markups: false }, markups, lines), p(202, 203), 1)?.kind).toBe('grid')
    expect(snapPoint(env({ pdf: false, grid: false }, markups, lines), p(302, 400), 1)).toBeNull()
    expect(snapPoint(env({ pdf: true, grid: false }, markups, lines), p(302, 400), 1)?.kind).toBe('pdf')
    expect(snapPoint(env({ grid: false }, markups, lines), p(212, 203), 1)?.kind).toBe('edge')
  })
})

describe('skipping and extra points', () => {
  it('ignores markups being moved', () => {
    const m = [mk('a', 'line', { x: 0, y: 0, rotation: 0, points: [0, 0, 100, 0] })]
    const e = env({ grid: false }, m)
    expect(snapPoint(e, { x: 2, y: 2 }, 1)?.kind).toBe('endpoint')
    expect(snapPoint(e, { x: 2, y: 2 }, 1, { skip: new Set(['a']) })).toBeNull()
  })

  it('snaps to the vertices of the shape being drawn', () => {
    const e = env({ grid: false })
    const hit = snapPoint(e, { x: 52, y: 51 }, 1, { extra: [{ x: 50, y: 50 }] })
    expect(hit).toMatchObject({ kind: 'endpoint', point: { x: 50, y: 50 } })
  })
})

describe('markup index', () => {
  it('uses rotated box corners and closes polygons', () => {
    const rect = mk('r', 'rect', { x: 100, y: 100, width: 50, height: 20, rotation: 90 })
    const e = env({ grid: false }, [rect])
    expect(snapPoint(e, { x: 80, y: 150 }, 1)?.point).toEqual({ x: 80, y: 150 }) // corner (50,20) rotated 90 about (100,100)
    const tri = mk('t', 'polygon', { x: 0, y: 0, rotation: 0, points: [0, 0, 100, 0, 0, 100] })
    const closing = snapPoint(env({ grid: false }, [tri]), { x: 0, y: 53 }, 1)
    expect(closing?.kind).toBe('midpoint') // midpoint of the closing edge (0,100)-(0,0)
    expect(closing?.point).toEqual({ x: 0, y: 50 })
  })

  it('skips freehand strokes', () => {
    const free = mk('f', 'freehand', { x: 0, y: 0, rotation: 0, points: [0, 0, 10, 10, 20, 0] })
    expect(snapPoint(env({ grid: false }, [free]), { x: 1, y: 1 }, 1)).toBeNull()
  })

  it('offers handles for dragging', () => {
    expect(handlePoints(mk('d', 'device', { x: 0, y: 0, width: 24, height: 24, rotation: 0 }))).toEqual([{ x: 12, y: 12 }])
    expect(handlePoints(mk('r', 'rect', { x: 0, y: 0, width: 10, height: 10, rotation: 0 }))).toHaveLength(5)
  })

  it('snapHandles picks the strongest source and returns the shift', () => {
    const target = [mk('t', 'device', { x: 288, y: 288, width: 24, height: 24, rotation: 0 })] // centre (300,300)
    const e = env({ grid: false }, target, [0, 303, 400, 303])
    const rect = mk('r', 'rect', { x: 280, y: 296, width: 20, height: 20, rotation: 0 })
    const res = snapHandles(e, handlePoints(rect), 1, { skip: new Set(['r']) })
    expect(res?.hit.kind).toBe('device') // the corner (300,296) is 4 from the device centre; the PDF line is a weaker source
    expect(res).toMatchObject({ dx: 0, dy: 4 })
  })
})

describe('helpers', () => {
  it('lineAngle is an undirected angle in (-90, 90]', () => {
    expect(lineAngle(0, 0, 10, 0)).toBe(0)
    expect(lineAngle(10, 0, 0, 0)).toBe(0)
    expect(lineAngle(0, 0, 0, 10)).toBe(90)
    expect(lineAngle(0, 10, 0, 0)).toBe(90)
    expect(lineAngle(0, 0, 10, -10)).toBe(-45)
  })

  it('grid step follows the scale in feet, else points', () => {
    expect(gridStep(DEFAULT_SNAP, 6)).toBe(6)
    expect(gridStep({ ...DEFAULT_SNAP, gridFeet: 2 }, 6)).toBe(12)
    expect(gridStep(DEFAULT_SNAP, null)).toBe(DEFAULT_SNAP.gridPoints)
  })

  it('normalizeSnap repairs bad stored values', () => {
    expect(normalizeSnap(null)).toEqual(DEFAULT_SNAP)
    expect(normalizeSnap({ on: false, pdf: 'x', gridFeet: -3, gridPoints: 24 })).toEqual({ ...DEFAULT_SNAP, on: false, gridPoints: 24 })
  })
})

describe('large indexes', () => {
  it('finds long diagonals and stays correct with many segments', () => {
    const flat: number[] = [0, 0, 2000, 2000]
    for (let i = 0; i < 5000; i++) flat.push(3000 + (i % 50) * 10, 3000 + Math.floor(i / 50) * 10, 3005 + (i % 50) * 10, 3000 + Math.floor(i / 50) * 10)
    const ix = SegIndex.fromSegments(flat)
    const hit = ix.nearestOnSegment(1000, 1004, 8)
    expect(hit?.x).toBeCloseTo(1002, 3)
    expect(hit?.y).toBeCloseTo(1002, 3)
    expect(ix.nearestOnSegment(1000, 1040, 8)).toBeNull()
  })
})
