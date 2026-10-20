import { describe, expect, it } from 'vitest'
import { decideOverlap, findOverlapTarget, isReplaceChoice, replacePrompt, replaceTargets } from './placeReplace'
import { detectStacks } from './stacks'
import type { Markup } from './types'

let n = 0
const dev = (tag: string, x: number, y: number, type: string | null = 'a', set = 'fa'): Markup => ({
  id: `d${++n}`, document_id: 'doc', page: 1, type: 'device', symbol_set_id: set, device_type_id: type, tag,
  geometry: { x, y, width: 24, height: 24, rotation: 0 },
  style: { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }, text: '', layer_id: null,
})

describe('findOverlapTarget', () => {
  it('finds a device of another type under the point, ignoring the same type', () => {
    const same = dev('FA-1', 0, 0, 'a'), other = dev('FA-2', 0, 0, 'b')
    expect(findOverlapTarget([same, other], { x: 12, y: 12 }, 'fa', 'a')).toBe(other)
    expect(findOverlapTarget([same], { x: 12, y: 12 }, 'fa', 'a')).toBeNull()
  })
  it('treats another symbol set as a different type and respects distance', () => {
    const o = dev('X-1', 0, 0, 'a', 'cam')
    expect(findOverlapTarget([o], { x: 12, y: 12 }, 'fa', 'a')).toBe(o)
    expect(findOverlapTarget([o], { x: 200, y: 200 }, 'fa', 'a')).toBeNull()
  })
})

describe('decideOverlap', () => {
  it('places when nothing is underneath', () => { expect(decideOverlap('ask', false)).toBe('place') })
  it('follows the saved choice', () => {
    expect(decideOverlap('ask', true)).toBe('ask')
    expect(decideOverlap('replace', true)).toBe('replace')
    expect(decideOverlap('both', true)).toBe('both')
  })
  it('validates stored values', () => {
    expect(isReplaceChoice('ask')).toBe(true)
    expect(isReplaceChoice('nope')).toBe(false)
  })
})

describe('replaceTargets / replacePrompt', () => {
  it('targets the whole stack, else the single device', () => {
    const a = dev('FA-1', 0, 0), b = dev('FA-2', 0, 0), c = dev('FA-3', 100, 100)
    const stacks = detectStacks([a, b, c])
    expect(replaceTargets(a, stacks).map(m => m.id).sort()).toEqual([a.id, b.id].sort())
    expect(replaceTargets(c, stacks)).toEqual([c])
  })
  it('words the prompt', () => {
    const a = dev('FA-1', 0, 0)
    expect(replacePrompt([a], 'Smoke', 'Camera')).toBe('Replace FA-1 Smoke with Camera?')
    expect(replacePrompt([a, a], 'Smoke', 'Camera')).toBe('Replace 2 Smoke with Camera?')
  })
})
