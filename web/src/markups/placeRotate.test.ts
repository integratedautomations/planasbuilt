import { describe, expect, it } from 'vitest'
import { angleFromTo, angleLabel, faceAngle, placeAngle, rotatesCoverage, snapAngle } from './placeRotate'
import { wallFacing } from './mount'
import type { BoxGeometry } from './types'

const box = (extra: Partial<BoxGeometry> = {}): BoxGeometry => ({ x: 0, y: 0, width: 24, height: 24, rotation: 0, ...extra })
const fov = (extra = {}) => ({ direction: -90, angle: 90, range: 100, ...extra })

describe('placeRotate', () => {
  it('measures page angles (0 right, 90 down)', () => {
    const c = { x: 10, y: 10 }
    expect(angleFromTo(c, { x: 20, y: 10 })).toBe(0)
    expect(angleFromTo(c, { x: 10, y: 20 })).toBe(90)
    expect(angleFromTo(c, { x: 10, y: 0 })).toBe(-90)
    expect(angleFromTo(c, { x: 0, y: 10 })).toBe(180)
    expect(angleFromTo(c, c)).toBeNull()
  })

  it('snaps to 15 degree steps and wraps at 180', () => {
    expect(snapAngle(7)).toBe(0)
    expect(snapAngle(8)).toBe(15)
    expect(snapAngle(-52)).toBe(-45)
    expect(snapAngle(179)).toBe(180)
    expect(snapAngle(-179)).toBe(180)
  })

  it('placeAngle snaps unless free (Alt)', () => {
    const c = { x: 0, y: 0 }
    const p = { x: 100, y: 100 * Math.tan((22 * Math.PI) / 180) }
    expect(placeAngle(c, p, false)).toBe(15)
    expect(placeAngle(c, p, true)).toBeCloseTo(22, 5)
    expect(placeAngle(c, c, false)).toBeNull()
  })

  it('points the coverage cone at the pointer and keeps the rotation', () => {
    const g = faceAngle(box({ rotation: 40, fov: fov() }), 30)
    expect(g.fov?.direction).toBe(30)
    expect(g.rotation).toBe(40)
    expect(g.fov?.angle).toBe(90)
  })

  it('rotates a device without coverage so its front faces the pointer', () => {
    for (const a of [-90, 0, 45, 90, 180, -135]) {
      const g = faceAngle(box(), a)
      // front is -90 in the device frame, so the page direction of the round side is rotation - 90
      const front = (((g.rotation ?? 0) - 90) % 360 + 360) % 360
      expect(front).toBeCloseTo(((a % 360) + 360) % 360, 5)
      expect(g.fov).toBeUndefined()
    }
    expect(faceAngle(box(), -90).rotation).toBe(0)
  })

  it('wall mount facing: round side ends up at the pointer for both cases', () => {
    const noCov = faceAngle(box(), 30)
    expect((((noCov.rotation ?? 0) + wallFacing(noCov)) % 360 + 360) % 360).toBeCloseTo(30, 5)
    const cov = faceAngle(box({ rotation: 20, fov: fov() }), 30)
    expect((((cov.rotation ?? 0) + wallFacing(cov)) % 360 + 360) % 360).toBeCloseTo(30, 5)
  })

  it('locked coverage rotates the device and leaves the cone alone', () => {
    const start = box({ fov: fov({ locked: true, direction: 10 }) })
    expect(rotatesCoverage(start)).toBe(false)
    const g = faceAngle(start, 90)
    expect(g.fov?.direction).toBe(10)
    expect(g.rotation).toBe(180)
    expect(rotatesCoverage(box({ fov: fov() }))).toBe(true)
    expect(rotatesCoverage(box())).toBe(false)
  })

  it('labels angles 0..359', () => {
    expect(angleLabel(-90)).toBe('270\u00b0')
    expect(angleLabel(180)).toBe('180\u00b0')
    expect(angleLabel(-0.2)).toBe('0\u00b0')
  })
})
