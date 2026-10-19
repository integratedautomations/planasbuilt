import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../offline/db'
import * as socket from './socket'

class MockWS {
  static instances: MockWS[] = []
  readyState = 0
  sent: any[] = []
  onopen: (() => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) { this.url = url; MockWS.instances.push(this) }
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }) }
  open() { this.readyState = 1; this.onopen?.() }
  recv(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
const last = () => MockWS.instances[MockWS.instances.length - 1]
/** Let queued promise work (and fake-indexeddb, which uses real timers internally) settle. */
const settle = async (ms = 30) => { await vi.advanceTimersByTimeAsync(ms) }

let store: Record<string, string>
let catchUp: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
let dispatched: Event[]

beforeEach(async () => {
  MockWS.instances = []
  store = { 'planmark.token': 'tok123' }
  dispatched = []
  vi.stubGlobal('WebSocket', MockWS)
  vi.stubGlobal('location', { protocol: 'https:', host: 'app.test' })
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } })
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store['s' + k] ?? null, setItem: (k: string, v: string) => { store['s' + k] = v } })
  vi.stubGlobal('window', { dispatchEvent: (e: Event) => { dispatched.push(e); return true }, addEventListener: () => {} })
  await Promise.all(db.tables.map(t => t.clear()))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  socket.resetSocketForTests()
  catchUp = vi.fn(async (_id: string) => {})
  socket.configureSocket({ catchUp, presenceIntervalMs: 100 })
})
afterEach(() => { socket.resetSocketForTests(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('reconnectDelay', () => {
  it('doubles from 1s to 30s with up to 25% jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(a => socket.reconnectDelay(a, 0))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(socket.reconnectDelay(0, 1)).toBe(1250)
  })
})

describe('connection', () => {
  it('connects with token and clientId, joins on open and catches up', async () => {
    socket.joinDocument('d1')
    const ws = last()
    expect(ws.url).toMatch(/^wss:\/\/app\.test\/api\/ws\?token=tok123&clientId=[\w-]+$/)
    expect(socket.getStatus()).toBe('reconnecting')
    ws.open()
    expect(socket.getStatus()).toBe('live')
    expect(ws.sent[0]).toEqual({ type: 'join', documentId: 'd1' })
    await settle()
    expect(catchUp).toHaveBeenCalledWith('d1')
  })

  it('does not connect without a token', () => {
    store = {}
    socket.connect()
    expect(MockWS.instances).toHaveLength(0)
    expect(socket.getStatus()).toBe('idle')
  })

  it('reconnects with backoff, re-joins and catches up again', async () => {
    socket.joinDocument('d1')
    last().open()
    await settle()
    last().close(1006)
    expect(socket.getStatus()).toBe('reconnecting')
    expect(MockWS.instances).toHaveLength(1)
    await settle(1300)
    expect(MockWS.instances).toHaveLength(2)
    last().open()
    await settle()
    expect(last().sent[0]).toEqual({ type: 'join', documentId: 'd1' })
    expect(catchUp).toHaveBeenCalledTimes(2)
  })

  it('treats 4401 as an expired session and does not retry', async () => {
    socket.joinDocument('d1')
    last().open()
    last().close(4401)
    expect(store['planmark.token']).toBeUndefined()
    expect(dispatched.some(e => e.type === 'planmark:signed-out')).toBe(true)
    await settle(60_000)
    expect(MockWS.instances).toHaveLength(1)
    expect(socket.getStatus()).toBe('idle')
  })

  it('pings every 25s', async () => {
    socket.joinDocument('d1')
    last().open()
    last().sent.length = 0
    await settle(25_000)
    expect(last().sent).toEqual([{ type: 'ping' }])
    last().recv({ type: 'pong' })
    await settle(25_000)
    expect(last().sent).toHaveLength(2)
  })
})

describe('messages', () => {
  it('tracks peers and applies remote markups to Dexie, then notifies listeners', async () => {
    socket.joinDocument('d1')
    const ws = last()
    ws.open()
    const seen: any[] = []
    socket.on('markup', m => seen.push(m))
    ws.recv({ type: 'peers', peers: [{ clientId: 'p1', userId: 'u1', name: 'Dana', color: '#000', page: 1, cursor: null, selection: [] }] })
    ws.recv({ type: 'markup', op: 'upsert', by: 'Dana', markup: { id: 'm1', document_id: 'd1', page: 1, type: 'device' } })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(socket.getPeers().map(p => p.name)).toEqual(['Dana'])
    expect(seen[0]).toMatchObject({ op: 'upsert', applied: true })
    expect((await db.markups.get('m1'))?.id).toBe('m1')
    ws.recv({ type: 'leave', clientId: 'p1' })
    await settle()
    expect(socket.getPeers()).toEqual([])
  })

  it('sends throttled presence only while in a document', async () => {
    socket.sendPresence({ page: 1, cursor: null, selection: [] }) // no document yet: dropped
    socket.joinDocument('d1')
    const ws = last()
    ws.open()
    ws.sent.length = 0
    for (let i = 0; i < 30; i++) { socket.sendPresence({ page: 1, cursor: { x: i, y: 0 }, selection: [] }); await settle(10) }
    await settle(200)
    const pres = ws.sent.filter(m => m.type === 'presence')
    expect(pres.length).toBeLessThanOrEqual(5)
    expect(pres[pres.length - 1].cursor.x).toBe(29)
  })
})
