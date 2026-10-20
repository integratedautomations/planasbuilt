import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { openDb, migrate } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
let port = 0
let tokA = '', tokB = '', tokC = '', docId = '', userA = ''
const markupId = '11111111-1111-4111-8111-111111111111'

const post = (url: string, token: string, payload: any, method: 'POST' | 'PUT' | 'DELETE' = 'POST', clientId?: string) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...(clientId ? { 'x-client-id': clientId } : {}) } })

class Client {
  msgs: any[] = []
  ws: WebSocket
  closed: Promise<number>
  opened: Promise<void>
  constructor(token: string, clientId: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}&clientId=${clientId}`)
    this.ws.on('message', d => this.msgs.push(JSON.parse(String(d))))
    this.opened = new Promise(r => this.ws.on('open', () => r()))
    this.closed = new Promise(r => this.ws.on('close', code => r(code)))
  }
  send(m: any) { this.ws.send(JSON.stringify(m)) }
  async next(type: string, ms = 2000) {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const i = this.msgs.findIndex(m => m.type === type)
      if (i >= 0) return this.msgs.splice(i, 1)[0]
      await new Promise(r => setTimeout(r, 10))
    }
    throw new Error(`timeout waiting for ${type}`)
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const open: Client[] = []
const connect = async (token: string, id: string) => { const c = new Client(token, id); open.push(c); await c.opened; return c }

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-rt-')) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as any).port
  const setup = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann', password: 'password1' } })).json()
  tokA = setup.token; userA = setup.user.id
  await post('/api/users', tokA, { email: 'b@x.com', name: 'Bob', password: 'password1' })
  await post('/api/users', tokA, { email: 'c@x.com', name: 'Cy', password: 'password1' })
  const login = async (e: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: e, password: 'password1' } })).json().token
  tokB = await login('b@x.com'); tokC = await login('c@x.com')
  const pid = (await post('/api/projects', tokA, { name: 'P' })).json().id
  await post(`/api/projects/${pid}/members`, tokA, { email: 'b@x.com', role: 'editor' }, 'PUT')
  const boundary = 'XX'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    await makePdf(1), Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  docId = (await app.inject({ method: 'POST', url: `/api/projects/${pid}/documents`,
    headers: { authorization: `Bearer ${tokA}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })).json().id
})

afterAll(async () => {
  for (const c of open) c.ws.terminate()
  await app.close()
})

describe('realtime', () => {
  it('closes sockets with an invalid token', async () => {
    const c = new Client('garbage', 'x')
    expect(await c.closed).toBe(4401)
  })

  let a: Client, b: Client

  it('join returns peers and notifies existing members', async () => {
    a = await connect(tokA, 'client-a')
    a.send({ type: 'join', documentId: docId })
    expect((await a.next('peers')).peers).toEqual([])
    b = await connect(tokB, 'client-b')
    b.send({ type: 'join', documentId: docId })
    const peers = (await b.next('peers')).peers
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ clientId: 'client-a', userId: userA, name: 'Ann', page: null, cursor: null, selection: [] })
    expect(peers[0].color).toMatch(/^#/)
    const peer = (await a.next('peer')).peer
    expect(peer).toMatchObject({ clientId: 'client-b', name: 'Bob' })
  })

  it('relays presence and ping/pong', async () => {
    b.send({ type: 'presence', page: 2, cursor: { x: 1, y: 2 }, selection: ['m1'] })
    expect((await a.next('peer')).peer).toMatchObject({ clientId: 'client-b', page: 2, cursor: { x: 1, y: 2 }, selection: ['m1'] })
    a.send({ type: 'ping' })
    await a.next('pong')
  })

  it('relays viewport and marquee, dropping invalid rects', async () => {
    b.send({ type: 'presence', page: 1, cursor: null, selection: [], viewport: { x: 1, y: 2, w: 300, h: 200 }, marquee: { x: 5, y: 6, w: 10, h: 12 } })
    expect((await a.next('peer')).peer).toMatchObject({ viewport: { x: 1, y: 2, w: 300, h: 200 }, marquee: { x: 5, y: 6, w: 10, h: 12 } })
    b.send({ type: 'presence', page: 1, cursor: null, selection: [], viewport: { x: 'a', y: 2, w: 3, h: 4 }, marquee: null })
    expect((await a.next('peer')).peer).toMatchObject({ viewport: null, marquee: null })
  })

  it('broadcasts markup upserts to others but not the origin', async () => {
    const res = await post(`/api/documents/${docId}/markups/${markupId}`, tokA,
      { type: 'rect', page: 1, geometry: { x: 1 } }, 'PUT', 'client-a')
    expect(res.statusCode).toBe(200)
    const m = await b.next('markup')
    expect(m).toMatchObject({ op: 'upsert', by: userA, markup: { id: markupId, created_by_name: 'Ann', updated_by_name: 'Ann' } })
    await sleep(150)
    expect(a.msgs.filter(x => x.type === 'markup')).toHaveLength(0)
  })

  it('broadcasts deletes', async () => {
    await post(`/api/documents/${docId}/markups/${markupId}`, tokA, undefined, 'DELETE', 'client-a')
    expect(await b.next('markup')).toMatchObject({ op: 'delete', id: markupId, by: userA })
  })

  it('rejects join for non-members', async () => {
    const c = await connect(tokC, 'client-c')
    c.send({ type: 'join', documentId: docId })
    expect((await c.next('error')).message).toBeTruthy()
  })

  it('sends leave on close', async () => {
    b.ws.close()
    expect(await a.next('leave')).toEqual({ type: 'leave', clientId: 'client-b' })
  })
})
