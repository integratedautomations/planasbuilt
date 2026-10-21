import { describe, expect, it } from 'vitest'
import { BoundedTtlMap } from './ttlmap.js'

describe('BoundedTtlMap', () => {
  it('evicts the oldest entries one at a time, never everything', () => {
    const m = new BoundedTtlMap<number>(3, 1000)
    for (let i = 0; i < 10; i++) m.set(`k${i}`, i)
    expect(m.size).toBe(3)
    expect([m.get('k6'), m.get('k7'), m.get('k8'), m.get('k9')]).toEqual([undefined, 7, 8, 9].map(v => v))
  })

  it('keeps an entry that is rewritten while junk comes and goes', () => {
    const m = new BoundedTtlMap<number>(5, 1000)
    m.set('victim', 1)
    for (let i = 0; i < 4; i++) m.set(`j${i}`, i)
    m.set('victim', 2) // rewritten: now the newest
    for (let i = 4; i < 8; i++) m.set(`j${i}`, i)
    expect(m.get('victim')).toBe(2)
    expect(m.size).toBe(5)
  })

  it('forgets entries after the ttl', () => {
    let t = 0
    const m = new BoundedTtlMap<string>(10, 100, () => t)
    m.set('a', 'x'); t = 99
    expect(m.get('a')).toBe('x')
    t = 100
    expect(m.get('a')).toBeUndefined()
    expect(m.size).toBe(0)
  })
})
