import { beforeEach, describe, expect, it } from 'vitest'
import { loadLastView, saveLastView } from './lastView'

const mem = new Map<string, string>()
beforeEach(() => {
  mem.clear()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) },
  } as Storage
})

describe('lastView', () => {
  it('round-trips per document and page', () => {
    saveLastView('d1', 2, { x: 10.4, y: -20, zoom: 1.23456789 })
    expect(loadLastView('d1', 2)).toEqual({ x: 10, y: -20, zoom: 1.2346 })
    expect(loadLastView('d1', 3)).toBeNull()
    expect(loadLastView('d2', 2)).toBeNull()
  })
  it('ignores junk', () => {
    mem.set('planmark.lastview.d.1', '{"x":"a"}')
    expect(loadLastView('d', 1)).toBeNull()
    mem.set('planmark.lastview.d.1', 'not json')
    expect(loadLastView('d', 1)).toBeNull()
  })
})
