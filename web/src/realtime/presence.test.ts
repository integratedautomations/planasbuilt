import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { viewportRect, viewForRect, avatarStack, createPresenceThrottle, initials, reducePeers, userColor } from './presence'
import type { Peer, PresenceOut } from './presence'

const peer = (clientId: string, over: Partial<Peer> = {}): Peer => ({
  clientId, userId: 'u-' + clientId, name: 'Dana Lee', color: '#e8590c', page: 1, cursor: null, selection: [], ...over,
})

describe('reducePeers', () => {
  it('replaces on peers, upserts on peer, removes on leave, ignores itself', () => {
    let s = reducePeers([], { type: 'peers', peers: [peer('a'), peer('me')] }, 'me')
    expect(s.map(p => p.clientId)).toEqual(['a'])
    s = reducePeers(s, { type: 'peer', peer: peer('b') }, 'me')
    expect(s.map(p => p.clientId)).toEqual(['a', 'b'])
    s = reducePeers(s, { type: 'peer', peer: peer('a', { page: 3 }) }, 'me')
    expect(s.find(p => p.clientId === 'a')!.page).toBe(3)
    expect(reducePeers(s, { type: 'peer', peer: peer('me') }, 'me')).toBe(s)
    s = reducePeers(s, { type: 'leave', clientId: 'a' }, 'me')
    expect(s.map(p => p.clientId)).toEqual(['b'])
    expect(reducePeers(s, { type: 'leave', clientId: 'zzz' }, 'me')).toBe(s)
    expect(reducePeers(s, { type: 'markup' }, 'me')).toBe(s)
  })
})

describe('avatars', () => {
  it('makes initials', () => {
    expect(initials('Dana Lee')).toBe('DL')
    expect(initials('  dana ')).toBe('D')
    expect(initials('')).toBe('?')
  })
  it('shows 4 people and counts the rest, one per user', () => {
    const peers = [1, 2, 3, 4, 5, 6].map(n => peer('c' + n))
    peers.push(peer('dup', { userId: 'u-c1' }))
    const { shown, more } = avatarStack(peers, 4)
    expect(shown).toHaveLength(4)
    expect(more).toBe(2)
  })
})

describe('presence throttle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
  afterEach(() => vi.useRealTimers())
  const p = (x: number): PresenceOut => ({ page: 1, cursor: { x, y: 0 }, selection: [] })

  it('sends the first at once and collapses a burst to ~10/s with the newest value last', () => {
    const sent: PresenceOut[] = []
    const t = createPresenceThrottle(x => sent.push(x), 100)
    for (let i = 0; i < 50; i++) { t.push(p(i)); vi.advanceTimersByTime(10) } // 50 updates over 500ms
    vi.advanceTimersByTime(200)
    expect(sent[0].cursor!.x).toBe(0)
    expect(sent.length).toBeLessThanOrEqual(7)
    expect(sent.length).toBeGreaterThanOrEqual(4)
    expect(sent[sent.length - 1].cursor!.x).toBe(49)
  })

  it('drops identical updates and resends after reset', () => {
    const sent: PresenceOut[] = []
    const t = createPresenceThrottle(x => sent.push(x), 100)
    t.push(p(1)); vi.advanceTimersByTime(150)
    t.push(p(1)); vi.advanceTimersByTime(150)
    expect(sent).toHaveLength(1)
    t.reset(); t.push(p(1)); vi.advanceTimersByTime(150)
    expect(sent).toHaveLength(2)
  })
})

describe('userColor', () => {
  it('is stable per user and always a palette colour', () => {
    expect(userColor('abc')).toBe(userColor('abc'))
    expect(userColor('abc')).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('viewport helpers', () => {
  it('converts a stage transform to a page rect and back', () => {
    const r = viewportRect({ x: -100, y: -50, zoom: 2 }, { width: 800, height: 600 })!
    expect(r).toEqual({ x: 50, y: 25, w: 400, h: 300 })
    const v = viewForRect(r, { width: 800, height: 600 }, 0)!
    expect(v.zoom).toBeCloseTo(2)
    expect(v.x).toBeCloseTo(-100)
    expect(v.y).toBeCloseTo(-50)
  })
  it('rejects degenerate input', () => {
    expect(viewportRect({ x: 0, y: 0, zoom: 0 }, { width: 10, height: 10 })).toBeNull()
    expect(viewForRect({ x: 0, y: 0, w: 0, h: 5 }, { width: 10, height: 10 })).toBeNull()
  })
})
