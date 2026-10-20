import { describe, expect, it } from 'vitest'
import { centerIfOffscreen, unionBox } from './visibility'

const vp = { width: 800, height: 600 }
describe('centerIfOffscreen', () => {
  it('leaves an on-screen box alone', () => {
    expect(centerIfOffscreen({ x: 0, y: 0, zoom: 1 }, vp, { x: 100, y: 100, width: 20, height: 20 })).toBeNull()
  })
  it('returns the box centre when off-screen, accounting for pan and zoom', () => {
    expect(centerIfOffscreen({ x: 0, y: 0, zoom: 1 }, vp, { x: 1000, y: 100, width: 20, height: 20 })).toEqual({ x: 1010, y: 110 })
    expect(centerIfOffscreen({ x: -500, y: 0, zoom: 2 }, vp, { x: 300, y: 100, width: 0, height: 0 })).toBeNull()
    expect(centerIfOffscreen({ x: -500, y: 0, zoom: 2 }, vp, { x: 10, y: 100, width: 0, height: 0 })).toEqual({ x: 10, y: 100 })
  })
  it('treats the margin edge as off-screen', () => {
    expect(centerIfOffscreen({ x: 0, y: 0, zoom: 1 }, vp, { x: 5, y: 100, width: 0, height: 0 })).not.toBeNull()
  })
})
describe('unionBox', () => {
  it('merges boxes', () => {
    expect(unionBox([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 }])).toEqual({ x: 0, y: 0, width: 30, height: 15 })
    expect(unionBox([])).toBeNull()
  })
})
