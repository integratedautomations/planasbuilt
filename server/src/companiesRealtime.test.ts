// Realtime isolation between companies: catalog events reach only the sockets working in that company, and a socket can
// neither join another company's plans nor switch into a company the person does not belong to.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
let port = 0
let root = '', alice = '', carol = '', dave = ''
let c1 = '', c2 = '', doc1 = '', doc2 = '', daveId = ''
const markupId = '55555555-5555-4555-8555-555555555555'
const api = (method: string, url: string, token: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload, headers: { authorization: `Bearer ${token}`, ...headers } })
const cx = (id: string) => ({ 'x-company-id': id })
const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1' } })).json().token as string
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class Client {
  msgs: any[] = []
  ws: WebSocket
  opened: Promise<void>
  constructor(token: string, clientId: string, company?: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}&clientId=${clientId}${company ? `&company=${company}` : ''}`)
    this.ws.on('message', d => this.msgs.push(JSON.parse(String(d))))
    this.opened = new Promise(r => this.ws.on('open', () => r()))
  }
  send(m: any) { this.ws.send(JSON.stringify(m)) }
  async next(type: string, ms = 2000) {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const i = this.msgs.findIndex(m => m.type === type)
      if (i >= 0) return this.msgs.splice(i, 1)[0]
      await sleep(10)
    }
    throw new Error(`timeout waiting for ${type}`)
  }
  /** Waits a moment and returns the messages of a type that arrived (and clears them). */
  async quiet(type: string, ms = 200) {
    await sleep(ms)
    const got = this.msgs.filter(m => m.type === type)
    this.msgs = this.msgs.filter(m => m.type !== type)
    return got
  }
}
const open: Client[] = []
const connect = async (token: string, id: string, company?: string) => { const c = new Client(token, id, company); open.push(c); await c.opened; return c }
const upload = async (project: string, token: string, headers = {}) => {
  const body = Buffer.concat([
    Buffer.from('--XX\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n'), await makePdf(1), Buffer.from('\r\n--XX--\r\n')])
  return (await app.inject({ method: 'POST', url: `/api/projects/${project}/documents`, payload: body,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=XX', ...headers } })).json().id as string
}
const mkSet = (token: string, name: string, company?: string) =>
  api('POST', '/api/symbol-sets', token, { name, tag_prefix: 'T', color: '#1971c2', icon: '', fields: [], has_fov: false }, { 'x-client-id': 'someone-else', ...(company ? cx(company) : {}) })

let sa: Client, sc: Client, sd: Client

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-corthree-')) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as any).port
  root = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'root@x.com', name: 'Root', password: 'password1', setupCode: 'test-setup-code' } })).json().token
  c1 = (await api('GET', '/api/companies', root)).json()[0].id
  c2 = (await api('POST', '/api/companies', root, { name: 'Beta' })).json().id
  const mk = (email: string, company: string, isAdmin = false) =>
    api('POST', '/api/users', root, { email, name: email.split('@')[0], password: 'password1', isAdmin }, cx(company)).then(r => r.json().id as string)
  await mk('alice@x.com', c1, true)
  await mk('carol@x.com', c2, true)
  daveId = await mk('dave@x.com', c1)
  await api('PUT', `/api/companies/${c2}/members`, root, { email: 'dave@x.com', role: 'member' })
  alice = await login('alice@x.com'); carol = await login('carol@x.com'); dave = await login('dave@x.com')
  const p1 = (await api('POST', '/api/projects', alice, { name: 'P1' })).json().id
  const p2 = (await api('POST', '/api/projects', carol, { name: 'P2' })).json().id
  doc1 = await upload(p1, alice)
  doc2 = await upload(p2, carol)
  await api('PUT', `/api/projects/${p1}/members`, alice, { email: 'dave@x.com', role: 'editor' })
  sa = await connect(alice, 'sock-alice') // no company asked for: her only one
  sc = await connect(carol, 'sock-carol')
  sd = await connect(dave, 'sock-dave', c1)
})

afterAll(async () => {
  for (const c of open) c.ws.terminate()
  await app.close()
})

describe('realtime across companies', () => {
  it('catalog events reach only the sockets working in that company', async () => {
    expect((await mkSet(alice, 'Rt Set One')).statusCode).toBe(200)
    expect((await sa.next('symbol_sets')).companyId).toBe(c1)
    expect((await sd.next('symbol_sets')).companyId).toBe(c1)
    expect(await sc.quiet('symbol_sets')).toEqual([])
    expect((await mkSet(carol, 'Rt Set Two')).statusCode).toBe(200)
    expect((await sc.next('symbol_sets')).companyId).toBe(c2)
    expect(await sa.quiet('symbol_sets')).toEqual([])
    expect(await sd.quiet('symbol_sets')).toEqual([])
  })

  it('a socket can only switch into a company its user belongs to, and then follows that company', async () => {
    sa.send({ type: 'company', companyId: c2 })
    expect((await sa.next('error')).message).toBeTruthy()
    await mkSet(carol, 'Rt Set Three')
    expect(await sa.quiet('symbol_sets')).toEqual([]) // still in c1
    sd.send({ type: 'company', companyId: c2 })
    await sleep(100)
    await mkSet(carol, 'Rt Set Four')
    expect((await sd.next('symbol_sets')).companyId).toBe(c2)
    await mkSet(alice, 'Rt Set Five') // c1: dave moved away from it
    expect(await sd.quiet('symbol_sets')).toEqual([])
    sd.send({ type: 'company', companyId: c1 })
    await sleep(100)
    await mkSet(alice, 'Rt Set Six')
    expect((await sd.next('symbol_sets')).companyId).toBe(c1)
    await sc.quiet('symbol_sets')
  })

  it('a platform admin socket can work in any company', async () => {
    const sr = await connect(root, 'sock-root', c2)
    await mkSet(carol, 'Rt Set Seven')
    expect((await sr.next('symbol_sets')).companyId).toBe(c2)
    sr.send({ type: 'company', companyId: c1 })
    await sleep(100)
    await mkSet(alice, 'Rt Set Eight')
    expect((await sr.next('symbol_sets')).companyId).toBe(c1)
    await sa.quiet('symbol_sets'); await sd.quiet('symbol_sets'); await sc.quiet('symbol_sets')
  })

  it('plan rooms are closed to other companies, and markup events stay inside', async () => {
    sa.send({ type: 'join', documentId: doc2 })
    expect((await sa.next('error')).message).toBe('Not allowed')
    sc.send({ type: 'join', documentId: doc1 })
    expect((await sc.next('error')).message).toBe('Not allowed')
    sa.send({ type: 'join', documentId: doc1 })
    await sa.next('peers')
    sd.send({ type: 'join', documentId: doc1 })
    await sd.next('peers')
    sc.send({ type: 'join', documentId: doc2 })
    await sc.next('peers')
    const put = await api('PUT', `/api/documents/${doc1}/markups/${markupId}`, alice, { type: 'rect', page: 1, geometry: { x: 1 } }, { 'x-client-id': 'sock-alice' })
    expect(put.statusCode).toBe(200)
    expect((await sd.next('markup')).op).toBe('upsert')
    expect(await sc.quiet('markup')).toEqual([])
  })

  it('removing someone from a company takes their socket out of its rooms and catalog events', async () => {
    expect((await api('DELETE', `/api/companies/${c1}/members/${daveId}`, alice)).statusCode).toBe(200)
    await sd.quiet('markup'); await sd.quiet('symbol_sets'); await sd.quiet('peer'); await sd.quiet('leave')
    await api('PUT', `/api/documents/${doc1}/markups/${markupId}`, alice, { type: 'rect', page: 1, geometry: { x: 2 } }, { 'x-client-id': 'sock-alice' })
    await mkSet(alice, 'Rt Set Nine')
    expect(await sd.quiet('markup')).toEqual([])
    expect(await sd.quiet('symbol_sets')).toEqual([])
    // and cannot come back into the room
    sd.send({ type: 'join', documentId: doc1 })
    expect((await sd.next('error')).message).toBe('Not allowed')
    sd.send({ type: 'company', companyId: c1 })
    expect((await sd.next('error')).message).toBeTruthy()
  })
})
