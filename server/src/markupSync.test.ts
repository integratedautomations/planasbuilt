import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { openDb, migrate } from './db.js'
import { buildApp } from './app.js'
import { Realtime } from './realtime.js'
import { makePdf } from './testutil.js'

/** Offline-queued markup edits (base_version / restore), reference fallbacks, replay safety and websocket join races. */

let app: Awaited<ReturnType<typeof buildApp>>
let port = 0
let admin = '', project = ''
const h = () => ({ authorization: `Bearer ${admin}` })
const B = 'ZZ'
const upload = (url: string, bytes: Buffer, fields: Record<string, string> = {}) => app.inject({
  method: 'POST', url, headers: { ...h(), 'content-type': `multipart/form-data; boundary=${B}` },
  payload: Buffer.concat([
    ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${B}--\r\n`)]),
})
const newDoc = async (pages: number) => (await upload(`/api/projects/${project}/documents`, await makePdf(pages))).json().id as string
const geo = (x: number) => ({ x, y: 20, width: 30, height: 40, rotation: 0 })
let seq = 0
const mid = () => `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const put = (doc: string, id: string, body: object) => app.inject({ method: 'PUT', url: `/api/documents/${doc}/markups/${id}`, headers: h(), payload: { page: 1, type: 'rect', geometry: geo(10), ...body } })
const del = (doc: string, id: string) => app.inject({ method: 'DELETE', url: `/api/documents/${doc}/markups/${id}`, headers: h() })
const list = async (doc: string) => (await app.inject({ url: `/api/documents/${doc}/markups`, headers: h() })).json() as any[]
const pageOp = (doc: string, op: string, payload: object) => app.inject({ method: 'POST', url: `/api/documents/${doc}/pages/${op}`, headers: h(), payload })

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-ms-')) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as any).port
  admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann', password: 'password1' } })).json().token
  project = (await app.inject({ method: 'POST', url: '/api/projects', headers: h(), payload: { name: 'P' } })).json().id
})
afterAll(async () => { await app.close() })

describe('markup PUT with base_version', () => {
  it('refuses to resurrect a markup deleted after the client last saw it, but not when the client restores explicitly', async () => {
    const doc = await newDoc(1), id = mid()
    const created = await put(doc, id, {})
    expect(created.statusCode).toBe(200)
    const v = created.json().version
    expect((await del(doc, id)).statusCode).toBe(200)

    const stale = await put(doc, id, { text: 'offline edit', base_version: v })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ conflict: true, current: { id, deleted: true, page: 1 } })
    expect(await list(doc)).toHaveLength(0) // still deleted

    const restored = await put(doc, id, { text: 'undo', base_version: v, restore: true })
    expect(restored.statusCode).toBe(200)
    expect(restored.json().text).toBe('undo')
    expect(await list(doc)).toHaveLength(1)
  })

  it('keeps the old behaviour (last write wins) for clients that send no base_version', async () => {
    const doc = await newDoc(1), id = mid()
    await put(doc, id, {})
    await del(doc, id)
    const res = await put(doc, id, { text: 'old client' })
    expect(res.statusCode).toBe(200)
    expect(await list(doc)).toHaveLength(1)
  })

  it('does not treat ordinary edits by others as conflicts', async () => {
    const doc = await newDoc(1), id = mid()
    const v1 = (await put(doc, id, {})).json().version
    expect((await put(doc, id, { text: 'someone else' })).json().version).toBe(v1 + 1)
    const mine = await put(doc, id, { text: 'mine', base_version: v1 })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().text).toBe('mine')
  })

  it('does not apply an edit based on a page/geometry that a page operation changed, and answers with the current row', async () => {
    const doc = await newDoc(3), id = mid()
    const v1 = (await put(doc, id, { page: 3 })).json().version
    // reorder: page 3 becomes page 1
    expect((await pageOp(doc, 'reorder', { order: [3, 1, 2] })).statusCode).toBe(200)
    const moved = await put(doc, id, { page: 3, text: 'edit from before the move', base_version: v1 })
    expect(moved.statusCode).toBe(409)
    expect(moved.json().current).toMatchObject({ id, page: 1, deleted: false })
    expect((await list(doc))[0].text).toBe('')
    // based on the current version it goes through
    const ok = await put(doc, id, { page: 1, text: 'after', base_version: moved.json().current.version })
    expect(ok.statusCode).toBe(200)

    // rotate: geometry turns
    const v2 = ok.json().version
    expect((await pageOp(doc, 'rotate', { pages: [1], degrees: 90 })).statusCode).toBe(200)
    const rot = await put(doc, id, { page: 1, geometry: geo(10), base_version: v2 })
    expect(rot.statusCode).toBe(409)
    expect(rot.json().current.geometry.rotation).toBe(90)

    // deleting the page deletes the markup
    const v3 = rot.json().current.version
    expect((await pageOp(doc, 'delete', { pages: [1] })).statusCode).toBe(200)
    const gone = await put(doc, id, { page: 1, base_version: v3 })
    expect(gone.statusCode).toBe(409)
    expect(gone.json().current.deleted).toBe(true)
  })

  it('treats a revision restore as a structural change too', async () => {
    const doc = await newDoc(1), id = mid()
    const v1 = (await put(doc, id, {})).json().version
    expect((await upload(`/api/documents/${doc}/revisions`, await makePdf(1))).statusCode).toBe(200)
    const revs = (await app.inject({ url: `/api/documents/${doc}/revisions`, headers: h() })).json()
    const first = revs.find((r: any) => r.revision === 1)
    expect((await app.inject({ method: 'POST', url: `/api/documents/${doc}/revisions/${first.id}/make-current`, headers: h() })).statusCode).toBe(200)
    expect((await put(doc, id, { text: 'stale', base_version: v1 })).statusCode).toBe(409)
  })

  it('falls back to no layer when the layer is unknown', async () => {
    const doc = await newDoc(1)
    const res = await put(doc, mid(), { layer_id: '99999999-9999-4999-8999-999999999999' })
    expect(res.statusCode).toBe(200)
    expect(res.json().layer_id).toBeNull()
    expect((await put(doc, mid(), { layer_id: 'not-a-uuid' })).statusCode).toBe(200)
  })

  it('a replayed identical create (retry racing the original) ends up with one markup and one tag', async () => {
    const doc = await newDoc(1), id = mid()
    const set = (await app.inject({ url: '/api/symbol-sets', headers: h() })).json().find((s: any) => s.tag_prefix === 'CAM')
    const res = await Promise.all([0, 1, 2, 3].map(() => put(doc, id, { symbol_set_id: set.id, type: 'device' })))
    expect(res.map(r => r.statusCode)).toEqual([200, 200, 200, 200])
    expect(new Set(res.map(r => r.json().tag)).size).toBe(1)
    expect(await list(doc)).toHaveLength(1)
    // and the tag was not burned: the next new device gets the following number
    const next = await put(doc, mid(), { symbol_set_id: set.id, type: 'device' })
    const n = (t: string) => Number(t.split('-')[1])
    expect(n(next.json().tag)).toBe(n(res[0].json().tag) + 1)
  })
})

describe('websocket join races', () => {
  const room = async () => {
    const doc = await newDoc(1)
    const watcher = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${admin}&clientId=watch`)
    const wmsgs: any[] = []
    watcher.on('message', d => wmsgs.push(JSON.parse(String(d))))
    await new Promise(r => watcher.on('open', r))
    watcher.send(JSON.stringify({ type: 'join', documentId: doc }))
    await vi_wait(() => wmsgs.some(m => m.type === 'peers'))
    return { doc, watcher, wmsgs }
  }
  const vi_wait = async (fn: () => boolean, ms = 3000) => {
    const t = Date.now()
    while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)) }
  }

  it('keeps a join sent the moment the socket opens', async () => {
    const { doc, watcher, wmsgs } = await room()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${admin}&clientId=eager`)
    const msgs: any[] = []
    ws.on('message', d => msgs.push(JSON.parse(String(d))))
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', documentId: doc })))
    await vi_wait(() => msgs.some(m => m.type === 'peers'))
    await vi_wait(() => wmsgs.some(m => m.type === 'peer' && m.peer.clientId === 'eager'))
    ws.close(); watcher.close()
  })

  it('does not announce a leave while a reconnected socket with the same clientId is still in the room', async () => {
    const { doc, watcher, wmsgs } = await room()
    const join = (ws: WebSocket) => new Promise<void>(r => { ws.on('open', () => { ws.send(JSON.stringify({ type: 'join', documentId: doc })); setTimeout(r, 150) }) })
    const oldWs = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${admin}&clientId=tab-1`)
    await join(oldWs)
    const newWs = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${admin}&clientId=tab-1`)
    await join(newWs)
    wmsgs.length = 0
    oldWs.close() // the stale connection finally closes after the new one joined
    await new Promise(r => setTimeout(r, 300))
    expect(wmsgs.filter(m => m.type === 'leave')).toHaveLength(0)
    newWs.close()
    await vi_wait(() => wmsgs.some(m => m.type === 'leave' && m.clientId === 'tab-1'))
    watcher.close()
  })
})

describe('Realtime room bookkeeping', () => {
  const fake = () => {
    const sent: any[] = []
    return { sent, socket: { on() {}, readyState: 1, send: (s: string) => sent.push(JSON.parse(s)), ping() {}, terminate() {}, close() {} } as any }
  }
  it('never puts a removed connection back into a room', () => {
    const rt = new Realtime(1_000_000)
    const a = fake(), b = fake()
    const ca = rt.add(a.socket, { clientId: 'a', userId: 'u', name: 'A' })
    const cb = rt.add(b.socket, { clientId: 'b', userId: 'u', name: 'B' })
    rt.join(cb, 'doc')
    rt.remove(ca)
    rt.join(ca, 'doc') // e.g. a join that finished its DB check after the socket closed
    expect(ca.documentId).toBeNull()
    rt.markupChanged('doc', { id: 'm' }, 'u')
    expect(a.sent.filter(m => m.type === 'markup')).toHaveLength(0)
    expect(b.sent.filter(m => m.type === 'markup')).toHaveLength(1)
    rt.close()
  })
  it('leave is only announced when no other connection of that clientId remains', () => {
    const rt = new Realtime(1_000_000)
    const o = fake(), s1 = fake(), s2 = fake()
    const co = rt.add(o.socket, { clientId: 'obs', userId: 'u', name: 'O' })
    const c1 = rt.add(s1.socket, { clientId: 'x', userId: 'u', name: 'X' })
    const c2 = rt.add(s2.socket, { clientId: 'x', userId: 'u', name: 'X' })
    rt.join(co, 'doc'); rt.join(c1, 'doc'); rt.join(c2, 'doc')
    expect(s2.sent.find(m => m.type === 'peers').peers.map((p: any) => p.clientId)).toEqual(['obs'])
    o.sent.length = 0
    rt.remove(c1)
    expect(o.sent.filter(m => m.type === 'leave')).toHaveLength(0)
    rt.remove(c2)
    expect(o.sent.filter(m => m.type === 'leave')).toEqual([{ type: 'leave', clientId: 'x' }])
    rt.close()
  })
})
