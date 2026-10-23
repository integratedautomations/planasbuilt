import { describe, expect, it } from 'vitest'
import { alignBox, alignDevice, alignable, boxFromDragAligned, nearestSideRotation, normalToward, snapRotation, withCenter } from './align'
import { deviceCenter } from './geometry'
import { WALL_FLAT, wallFacing } from './mount'
import { norm180 } from './placeRotate'
import type { BoxGeometry } from './types'

const dev = (extra: Partial<BoxGeometry> = {}): BoxGeometry => ({ x: 88, y: 88, width: 24, height: 24, rotation: 0, ...extra })
const hit = (x: number, y: number, angle: number) => ({ point: { x, y }, kind: 'pdf' as const, angle })

describe('normalToward', () => {
  it('points to the side of the pointer', () => {
    expect(normalToward(0, { x: 0, y: 0 }, { x: 5, y: 10 })).toBe(90) // pointer below a horizontal wall: down
    expect(normalToward(0, { x: 0, y: 0 }, { x: 5, y: -10 })).toBe(-90)
    expect(normalToward(90, { x: 0, y: 0 }, { x: -10, y: 3 })).toBe(180)
    expect(normalToward(90, { x: 0, y: 0 }, { x: 10, y: 3 })).toBe(0)
  })
})

describe('alignDevice', () => {
  it('turns a plain wall D so its round side faces the pointer and its flat side sits on the line', () => {
    // horizontal wall at y = 100, pointer below it
    const out = alignDevice(dev(), hit(100, 100, 0), { x: 100, y: 104 }, 'wall')
    // front (the round side) is rotation - 90 degrees in the page
    expect(norm180(out.rotation - 90)).toBeCloseTo(90, 3)
    const c = deviceCenter(out)
    expect(c.x).toBeCloseTo(100, 1)
    expect(c.y).toBeCloseTo(100 + WALL_FLAT * 12, 1) // flat side (0.45 r behind the centre) is on the wall
    expect(c.y - WALL_FLAT * 12).toBeCloseTo(100, 1)
  })

  it('faces the other way when the pointer is on the other side', () => {
    const out = alignDevice(dev(), hit(100, 100, 0), { x: 100, y: 95 }, 'wall')
    expect(norm180(out.rotation - 90)).toBeCloseTo(-90, 3)
    expect(deviceCenter(out).y).toBeCloseTo(100 - WALL_FLAT * 12, 1)
  })

  it('works on a vertical wall', () => {
    const out = alignDevice(dev(), hit(200, 50, 90), { x: 206, y: 50 }, 'wall')
    expect(norm180(out.rotation - 90)).toBeCloseTo(0, 3) // faces right
    const c = deviceCenter(out)
    expect(c.x).toBeCloseTo(200 + WALL_FLAT * 12, 1)
    expect(c.y).toBeCloseTo(50, 1)
  })

  it('centres a non-wall device on the line', () => {
    const out = alignDevice(dev(), hit(100, 100, 0), { x: 100, y: 104 }, 'ceiling')
    expect(deviceCenter(out).x).toBeCloseTo(100, 3)
    expect(deviceCenter(out).y).toBeCloseTo(100, 3)
  })

  it('points coverage perpendicular to the wall, away from it, and leaves the rotation', () => {
    const fov = { direction: -90, angle: 90, range: 150 }
    const out = alignDevice(dev({ fov }), hit(100, 100, 0), { x: 100, y: 104 }, 'wall')
    expect(out.rotation).toBe(0)
    expect(out.fov?.direction).toBeCloseTo(90, 3) // away from a wall above the pointer
    expect(wallFacing(out)).toBeCloseTo(90, 3)
    expect(deviceCenter(out).y).toBeCloseTo(100 + WALL_FLAT * 12, 1)
  })

  it('a diagonal wall gives a perpendicular facing', () => {
    const out = alignDevice(dev(), hit(100, 100, 45), { x: 90, y: 110 }, 'wall')
    expect(norm180(out.rotation - 90)).toBeCloseTo(135, 3) // normal of a 45 degree wall, on the lower-left side
  })

  it('honours a per-device mount override', () => {
    const out = alignDevice(dev({ mount: 'ceiling' }), hit(100, 100, 0), { x: 100, y: 104 }, 'wall')
    expect(deviceCenter(out).y).toBeCloseTo(100, 3)
  })
})

describe('alignBox / sides', () => {
  it('picks the line angle plus a multiple of 90 closest to the current rotation', () => {
    expect(nearestSideRotation(0, 30)).toBe(30)
    expect(nearestSideRotation(80, 30)).toBe(120)
    expect(nearestSideRotation(200, 30)).toBe(210)
    expect(nearestSideRotation(-5, -30)).toBe(330)
  })

  it('turns a box about the snapped corner', () => {
    const out = alignBox({ x: 100, y: 100, width: 50, height: 20, rotation: 0 }, { x: 100, y: 100 }, 30)
    expect(out).toMatchObject({ rotation: 30, x: 100, y: 100 })
    // pivot elsewhere: the box swings around it
    const swung = alignBox({ x: 120, y: 100, width: 50, height: 20, rotation: 0 }, { x: 100, y: 100 }, 30)
    expect(swung.rotation).toBe(30)
    expect(swung.x).toBeCloseTo(117.32, 1)
    expect(swung.y).toBeCloseTo(110, 1)
    // a vertical wall already matches an unrotated box
    expect(alignBox({ x: 100, y: 100, width: 50, height: 20, rotation: 0 }, { x: 100, y: 100 }, 90).rotation).toBe(0)
  })

  it('draws a box in the frame of the line the first corner snapped to', () => {
    const b = boxFromDragAligned({ x: 0, y: 0 }, { x: 10, y: 10 }, 45)
    expect(b.rotation).toBe(45)
    expect(b.width).toBeCloseTo(14.14, 1)
    expect(b.height).toBeCloseTo(0, 1)
    const neg = boxFromDragAligned({ x: 0, y: 0 }, { x: -10, y: 0 }, 0)
    expect(neg).toMatchObject({ x: -10, y: 0, width: 10, height: 0, rotation: 0 })
    const sq = boxFromDragAligned({ x: 0, y: 0 }, { x: 30, y: 10 }, 0, true)
    expect(sq).toMatchObject({ width: 30, height: 30 })
  })

  it('keeps the centre when re-centering a turned box', () => {
    const g = withCenter({ x: 0, y: 0, width: 20, height: 10, rotation: 30 }, { x: 50, y: 60 })
    const c = deviceCenter(g)
    expect(c.x).toBeCloseTo(50, 1)
    expect(c.y).toBeCloseTo(60, 1)
  })
})

describe('snapRotation and alignable', () => {
  it('snaps to right angles within 5 degrees', () => {
    expect(snapRotation(3)).toBe(0)
    expect(snapRotation(86)).toBe(90)
    expect(snapRotation(-93)).toBe(270)
    expect(snapRotation(176)).toBe(180)
    expect(snapRotation(8)).toBe(8)
    expect(snapRotation(40)).toBe(40)
  })

  it('only lines have directions to align to', () => {
    expect(alignable({ point: { x: 0, y: 0 }, kind: 'pdf', angle: 10 })).toBe(true)
    expect(alignable({ point: { x: 0, y: 0 }, kind: 'edge', angle: 10 })).toBe(true)
    expect(alignable({ point: { x: 0, y: 0 }, kind: 'grid' })).toBe(false)
    expect(alignable({ point: { x: 0, y: 0 }, kind: 'device' })).toBe(false)
    expect(alignable(null)).toBe(false)
  })
})
