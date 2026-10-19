import { describe, expect, it } from 'vitest'
import { detectStacks, findSnapTarget, tagRange } from './stacks'
import type { Markup } from './types'

let n = 0
const dev = (tag: string, x: number, y: number, set = 'fa', page = 1, size = 24): Markup => ({
  id: `d${++n}`, document_id: 'doc', page, type: 'device', symbol_set_id: set, tag,
  geometry: { x, y, width: size, height: size, rotation: 0 },
  style: { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 },
  text: '', layer_id: null,
})

describe('detectStacks', () => {
  it('groups devices at the same spot, ordered by natural tag', () => {
    const { stacks, byId } = detectStacks([dev('FA-10', 0, 0), dev('FA-2', 0, 0), dev('FA-3', 0, 0)])
    expect(stacks).toHaveLength(1)
    expect(stacks[0].members.map(m => m.tag)).toEqual(['FA-2', 'FA-3', 'FA-10'])
    expect(byId.get(stacks[0].members[0].id)).toBe(stacks[0])
  })
  it('does not stack singles', () => {
    expect(detectStacks([dev('FA-1', 0, 0), dev('FA-2', 100, 100)]).stacks).toHaveLength(0)
  })
  it('chains via union-find', () => {
    // radius 12 -> threshold 3; 0 and 5 are too far apart directly but link through 2.5
    expect(detectStacks([dev('FA-1', 0, 0), dev('FA-2', 2.5, 0), dev('FA-3', 5, 0)]).stacks[0].members).toHaveLength(3)
  })
  it('respects the threshold: max(2, 0.25 r)', () => {
    expect(detectStacks([dev('A-1', 0, 0), dev('A-2', 3, 0)]).stacks).toHaveLength(1)
    expect(detectStacks([dev('A-1', 0, 0), dev('A-2', 3.5, 0)]).stacks).toHaveLength(0)
    expect(detectStacks([dev('A-1', 0, 0, 'fa', 1, 4), dev('A-2', 1.9, 0, 'fa', 1, 4)]).stacks).toHaveLength(1)
    expect(detectStacks([dev('A-1', 0, 0, 'fa', 1, 4), dev('A-2', 2.5, 0, 'fa', 1, 4)]).stacks).toHaveLength(0)
  })
  it('keeps different sets and pages apart', () => {
    expect(detectStacks([dev('FA-1', 0, 0, 'fa'), dev('CAM-1', 0, 0, 'cam')]).stacks).toHaveLength(0)
    expect(detectStacks([dev('FA-1', 0, 0, 'fa', 1), dev('FA-2', 0, 0, 'fa', 2)]).stacks).toHaveLength(0)
  })
  it('orders stacks by tag', () => {
    const { stacks } = detectStacks([dev('FA-20', 50, 50), dev('FA-21', 50, 50), dev('FA-2', 0, 0), dev('FA-3', 0, 0)])
    expect(stacks.map(s => s.members[0].tag)).toEqual(['FA-2', 'FA-20'])
  })
})

describe('findSnapTarget', () => {
  const a = dev('FA-1', 0, 0)
  it('snaps within 1.2 radius of the same set only', () => {
    expect(findSnapTarget([a], { x: 12 + 14, y: 12 }, 'fa')).toBe(a)
    expect(findSnapTarget([a], { x: 12 + 15, y: 12 }, 'fa')).toBeNull()
    expect(findSnapTarget([a], { x: 12, y: 12 }, 'cam')).toBeNull()
  })
  it('only joins a stack of the same device type', () => {
    const t = { ...a, id: 'typed', device_type_id: 'sd' }
    expect(findSnapTarget([t], { x: 12, y: 12 }, 'fa')).toBeNull()
    expect(findSnapTarget([t], { x: 12, y: 12 }, 'fa', 1.2, 'sd')).toBe(t)
    const { stacks } = detectStacks([t, { ...a, id: 'plain' }])
    expect(stacks).toHaveLength(0)
  })
})

describe('tagRange', () => {
  it('collapses consecutive tags', () => {
    expect(tagRange(['FA-12', 'FA-13', 'FA-14', 'FA-15', 'FA-16', 'FA-17'])).toBe('FA-12–FA-17')
    expect(tagRange(['FA-10', 'FA-9'])).toBe('FA-9–FA-10')
  })
  it('falls back to first +n', () => {
    expect(tagRange(['FA-12', 'FA-13', 'FA-15', 'FA-16', 'FA-17', 'FA-18'])).toBe('FA-12 +5')
    expect(tagRange(['FA-1', 'CAM-2'])).toBe('CAM-2 +1')
  })
  it('handles one or none', () => {
    expect(tagRange(['FA-1'])).toBe('FA-1')
    expect(tagRange([])).toBe('')
  })
})
