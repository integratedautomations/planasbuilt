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
const tok: Record<string, string> = {}
let pid = '', docId = '', camSet = '', faSet = '', layerId = ''
const camMarkup = '11111111-1111-4111-8111-111111111111'
const faMarkup = '22222222-2222-4222-8222-222222222222'
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who: string, payload?: any, clientId?: string) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok[who]}`, ...(clientId ? { 'x-client-id': clientId } : {}) } })

const base = (set: string, extra: any = {}) => ({
  type: 'device', page: 1, geometry: { x: 10, y: 20, w: 30, h: 30 }, symbol_set_id: set, status: 'planned', fields: { ip: '1.1.1.1' }, ...extra })

const wait = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 20)) }
async function listen(who: string, clientId: string) {
  const msgs: any[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${tok[who]}&clientId=${clientId}`)
  ws.on('message', d => msgs.push(JSON.parse(String(d))))
  await new Promise<void>(r => ws.on('open', () => r()))
  ws.send(JSON.stringify({ type: 'join', documentId: docId }))
  await wait(() => msgs.some(m => m.type === 'peers'))
  return { msgs, ws }
}

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-roles-')) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as any).port
  tok.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann', password: 'password1', setupCode: 'test-setup-code' } })).json().token
  pid = (await call('POST', '/api/projects', 'admin', { name: 'P' })).json().id
  for (const r of ['pm', 'editor', 'field', 'sub', 'client', 'viewer']) {
    await call('POST', '/api/users', 'admin', { email: `${r}@x.com`, name: r, password: 'password1' })
    tok[r] = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${r}@x.com`, password: 'password1' } })).json().token
  }
  const sets = (await call('GET', '/api/symbol-sets', 'admin')).json()
  camSet = sets.find((s: any) => s.name === 'Cameras').id
  faSet = sets.find((s: any) => s.name === 'Fire Alarm').id
  layerId = (await call('POST', `/api/projects/${pid}/layers`, 'admin', { name: 'L' })).json().id
  const boundary = 'XX'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    await makePdf(1), Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  docId = (await app.inject({ method: 'POST', url: `/api/projects/${pid}/documents`,
    headers: { authorization: `Bearer ${tok.admin}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })).json().id
})
afterAll(async () => { await app.close() })

describe('roles api', () => {
  it('accepts the new roles and a sub scope', async () => {
    for (const r of ['pm', 'editor', 'field', 'client', 'viewer'])
      expect((await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: `${r}@x.com`, role: r })).statusCode).toBe(200)
    expect((await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: 'sub@x.com', role: 'sub', scope: { sets: [faSet], layers: [] } })).statusCode).toBe(200)
    expect((await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: 'x@x.com', role: 'boss' })).statusCode).toBe(400)
    const members = (await call('GET', `/api/projects/${pid}/members`, 'admin')).json()
    expect(members.find((m: any) => m.email === 'sub@x.com')).toMatchObject({ role: 'sub', scope: { sets: [faSet], layers: [] } })
    // scopes are only shown to member managers
    expect((await call('GET', `/api/projects/${pid}/members`, 'field')).json()[0].scope).toBeUndefined()
  })

  it('only admins manage members and delete plans; pm edits plans', async () => {
    expect((await call('PUT', `/api/projects/${pid}/members`, 'pm', { email: 'viewer@x.com', role: 'editor' })).statusCode).toBe(403)
    expect((await call('PATCH', `/api/documents/${docId}`, 'pm', { name: 'Renamed' })).statusCode).toBe(200)
    expect((await call('PATCH', `/api/documents/${docId}`, 'field', { name: 'Nope' })).statusCode).toBe(403)
    expect((await call('PATCH', `/api/documents/${docId}`, 'sub', { name: 'Nope' })).statusCode).toBe(403)
    expect((await call('PATCH', `/api/documents/${docId}`, 'client', { name: 'Nope' })).statusCode).toBe(403)
    expect((await call('POST', `/api/projects/${pid}/layers`, 'field', { name: 'Nope' })).statusCode).toBe(403)
    expect((await call('DELETE', `/api/documents/${docId}`, 'pm')).statusCode).toBe(403)
  })

  it('creates markups for editors only; field/sub/client/viewer cannot create or delete', async () => {
    expect((await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'editor', base(camSet))).statusCode).toBe(200)
    expect((await call('PUT', `/api/documents/${docId}/markups/${faMarkup}`, 'pm', base(faSet, { geometry: { x: 50, y: 50, w: 30, h: 30 } }))).statusCode).toBe(200)
    const other = '33333333-3333-4333-8333-333333333333'
    for (const who of ['field', 'sub', 'client', 'viewer'])
      expect((await call('PUT', `/api/documents/${docId}/markups/${other}`, who, base(camSet))).statusCode).toBe(403)
    for (const who of ['field', 'sub', 'client', 'viewer'])
      expect((await call('DELETE', `/api/documents/${docId}/markups/${camMarkup}`, who)).statusCode).toBe(403)
  })

  it('field may change only fields, status and notes', async () => {
    const cur = (await call('GET', `/api/documents/${docId}/markups`, 'field')).json().find((m: any) => m.id === camMarkup)
    const full = (over: any = {}) => ({ type: cur.type, page: cur.page, geometry: cur.geometry, style: cur.style, text: cur.text, layer_id: cur.layer_id,
      symbol_set_id: cur.symbol_set_id, device_type_id: cur.device_type_id, product_id: cur.product_id, tag: cur.tag, status: cur.status, fields: cur.fields, ...over })
    const ok = await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'field', full({ status: 'installed', fields: { ip: '2.2.2.2', notes: 'mounted' } }))
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'installed', fields: { ip: '2.2.2.2', notes: 'mounted' }, geometry: cur.geometry })
    // blank tag means unchanged
    expect((await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'field', full({ tag: '', status: 'tested' }))).statusCode).toBe(200)
    for (const over of [
      { geometry: { ...cur.geometry, x: cur.geometry.x + 1 } },
      { page: 2 }, { type: 'rect' }, { text: 'hello' }, { tag: 'ZZ-99' }, { style: { color: 'red' } },
      { layer_id: layerId }, { symbol_set_id: faSet },
    ]) {
      const res = await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'field', full(over))
      expect(res.statusCode, JSON.stringify(over)).toBe(403)
    }
    const after = (await call('GET', `/api/documents/${docId}/markups`, 'admin')).json().find((m: any) => m.id === camMarkup)
    expect(after.geometry).toEqual(cur.geometry)
    expect(after.status).toBe('tested')
  })

  it('a sub is limited to their scope for list, edit, history and photos', async () => {
    const list = (await call('GET', `/api/documents/${docId}/markups`, 'sub')).json()
    expect(list.map((m: any) => m.id)).toEqual([faMarkup])
    expect((await call('GET', `/api/projects/${pid}/markups`, 'sub')).json().map((m: any) => m.id)).toEqual([faMarkup])
    expect((await call('GET', `/api/projects/${pid}/markups?type=device`, 'sub')).json().map((m: any) => m.id)).toEqual([faMarkup])
    expect((await call('GET', `/api/projects/${pid}/markups`, 'field')).json()).toHaveLength(2)
    const mine = list[0]
    const edit = (id: string, over: any = {}) => call('PUT', `/api/documents/${docId}/markups/${id}`, 'sub',
      { type: mine.type, page: mine.page, geometry: mine.geometry, style: mine.style, text: mine.text, symbol_set_id: faSet, status: 'installed', fields: { notes: 'x' }, ...over })
    expect((await edit(faMarkup)).statusCode).toBe(200)
    expect((await edit(faMarkup, { geometry: { x: 1, y: 1, w: 1, h: 1 } })).statusCode).toBe(403)
    expect((await edit(camMarkup, { symbol_set_id: camSet })).statusCode).toBe(403)
    expect((await call('GET', `/api/markups/${camMarkup}/history`, 'sub')).statusCode).toBe(404)
    expect((await call('GET', `/api/markups/${faMarkup}/history`, 'sub')).statusCode).toBe(200)
    expect((await call('GET', `/api/markups/${camMarkup}/attachments`, 'sub')).statusCode).toBe(404)
    expect((await call('GET', `/api/markups/${faMarkup}/attachments`, 'sub')).statusCode).toBe(200)
    // revision snapshots are filtered too
    const revs = (await call('GET', `/api/documents/${docId}`, 'admin')).json().revisions
    const rev = (await call('GET', `/api/documents/${docId}/revisions/${revs[0].id}`, 'sub')).json()
    expect(rev.markups.map((m: any) => m.id)).toEqual([faMarkup])
  })

  it('an empty scope sees nothing, and a set in scope shows its markups', async () => {
    await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: 'sub@x.com', role: 'sub', scope: { sets: [], layers: [] } })
    expect((await call('GET', `/api/documents/${docId}/markups`, 'sub')).json()).toEqual([])
    await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: 'sub@x.com', role: 'sub', scope: { sets: [camSet], layers: [] } })
    expect((await call('GET', `/api/documents/${docId}/markups`, 'sub')).json().map((m: any) => m.id)).toEqual([camMarkup])
    // omitting the scope keeps it
    await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: 'sub@x.com', role: 'sub' })
    expect((await call('GET', `/api/documents/${docId}/markups`, 'sub')).json()).toHaveLength(1)
    await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: 'sub@x.com', role: 'sub', scope: { sets: [faSet], layers: [] } })
  })
})

describe('realtime filtering', () => {
  it('sends a sub only markups in scope and turns an out-of-scope move into a delete', async () => {
    const { msgs, ws } = await listen('sub', 'sub1')
    const ofKind = () => msgs.filter(m => m.type === 'markup')

    await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'editor', base(camSet, { status: 'punch' }), 'ed1')
    await call('PUT', `/api/documents/${docId}/markups/${faMarkup}`, 'editor', base(faSet, { status: 'punch', geometry: { x: 51, y: 50, w: 30, h: 30 } }), 'ed1')
    await wait(() => ofKind().length >= 1)
    await new Promise(r => setTimeout(r, 150))
    expect(ofKind().map(m => [m.op, m.markup?.id])).toEqual([['upsert', faMarkup]])

    msgs.length = 0
    await call('PUT', `/api/documents/${docId}/markups/${faMarkup}`, 'editor', base(camSet, { geometry: { x: 51, y: 50, w: 30, h: 30 } }), 'ed1')
    await wait(() => ofKind().length >= 1)
    expect(ofKind()).toEqual([expect.objectContaining({ op: 'delete', id: faMarkup })])
    ws.terminate()
  })

  it('a scope change reloads the sub and applies to later broadcasts', async () => {
    const { msgs, ws } = await listen('sub', 'sub2')
    await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: 'sub@x.com', role: 'sub', scope: { sets: [camSet], layers: [] } })
    await wait(() => msgs.some(m => m.type === 'markups_reset'))
    expect(msgs.some(m => m.type === 'markups_reset')).toBe(true)
    msgs.length = 0
    await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'editor', base(camSet, { status: 'installed' }), 'ed1')
    await wait(() => msgs.some(m => m.type === 'markup'))
    expect(msgs.find(m => m.type === 'markup')).toMatchObject({ op: 'upsert', markup: { id: camMarkup } })
    ws.terminate()
  })
})

describe('costs and internal fields', () => {
  let prodId = ''
  it('strips cost and labor for roles without costs.view', async () => {
    const types = (await call('GET', '/api/catalog', 'admin')).json().device_types
    const created = await call('POST', '/api/products', 'admin', { kind: 'device', device_type_id: types[0].id, manufacturer: 'M', model: 'X1', unit_cost: 120, labor_hours: 2,
      accessories: [{ name: 'bracket', unit_cost: 5, labor_hours: 0.5, qty: 1 }] })
    prodId = created.json().id
    const find = (cat: any) => cat.products.find((p: any) => p.id === prodId)
    for (const who of ['admin', 'pm', 'editor', 'viewer']) {
      const cat = (await call('GET', '/api/catalog', who)).json()
      expect(find(cat), who).toMatchObject({ unit_cost: 120, labor_hours: 2 })
      expect(cat.can_see_costs).toBe(true)
    }
    for (const who of ['field', 'sub', 'client']) {
      const cat = (await call('GET', '/api/catalog', who)).json()
      const p = find(cat)
      expect(p.model, who).toBe('X1')
      expect(p).not.toHaveProperty('unit_cost')
      expect(p).not.toHaveProperty('labor_hours')
      expect(p.accessories[0]).not.toHaveProperty('unit_cost')
      expect(cat.can_see_costs).toBe(false)
    }
  })

  it('editors lose costs when the project switches editors_see_costs off; pm keeps them', async () => {
    expect((await call('PATCH', `/api/projects/${pid}`, 'editor', { editors_see_costs: false })).statusCode).toBe(403)
    expect((await call('PATCH', `/api/projects/${pid}`, 'admin', { editors_see_costs: false })).statusCode).toBe(200)
    const cat = (await call('GET', '/api/catalog', 'editor')).json()
    expect(cat.products.find((p: any) => p.id === prodId)).not.toHaveProperty('unit_cost')
    expect((await call('GET', '/api/catalog', 'pm')).json().products.find((p: any) => p.id === prodId).unit_cost).toBe(120)
    expect((await call('GET', `/api/projects/${pid}`, 'editor')).json().can_see_costs).toBe(false)
    expect((await call('GET', `/api/projects/${pid}`, 'pm')).json().can_see_costs).toBe(true)
    await call('PATCH', `/api/projects/${pid}`, 'admin', { editors_see_costs: true })
    expect((await call('GET', '/api/catalog', 'editor')).json().products.find((p: any) => p.id === prodId).unit_cost).toBe(120)
  })

  it('hides internal fields from clients (definitions and values)', async () => {
    const sets = (await call('GET', '/api/symbol-sets', 'admin')).json()
    const cam = sets.find((s: any) => s.id === camSet)
    const put = await call('PUT', `/api/symbol-sets/${camSet}`, 'admin', { ...cam, fields: [...cam.fields, { key: 'admin_pw', label: 'Admin password', type: 'text', internal: true }] })
    expect(put.json().fields.find((f: any) => f.key === 'admin_pw').internal).toBe(true)
    await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'editor', base(camSet, { fields: { ip: '9.9.9.9', admin_pw: 'secret' } }))
    const keys = (who: string) => call('GET', `/api/symbol-sets`, who).then(r => r.json().find((s: any) => s.id === camSet).fields.map((f: any) => f.key))
    expect(await keys('editor')).toContain('admin_pw')
    expect(await keys('client')).not.toContain('admin_pw')
    const markup = async (who: string) => (await call('GET', `/api/documents/${docId}/markups`, who)).json().find((m: any) => m.id === camMarkup)
    expect((await markup('viewer')).fields.admin_pw).toBe('secret')
    expect((await markup('client')).fields).toEqual({ ip: '9.9.9.9' })
    expect((await call('GET', `/api/projects/${pid}/markups`, 'client')).json().find((m: any) => m.id === camMarkup).fields).toEqual({ ip: '9.9.9.9' })
  })
  it('strips internal field values from a marker history and hides emails from non-managers', async () => {
    await call('PUT', `/api/documents/${docId}/markups/${camMarkup}`, 'editor', base(camSet, { fields: { ip: '8.8.8.8', admin_pw: 'newsecret' }, version: undefined }))
    const hist = async (who: string) => JSON.stringify((await call('GET', `/api/markups/${camMarkup}/history`, who)).json())
    expect(await hist('viewer')).toContain('newsecret')
    const forClient = await hist('client')
    expect(forClient).not.toContain('newsecret')
    expect(forClient).not.toContain('secret')
    expect(forClient).not.toContain('fields.admin_pw')
    expect(forClient).toContain('fields.ip')
    const dir = (await call('GET', '/api/users/directory', 'field')).json()
    expect(dir.length).toBeGreaterThan(0)
    for (const u of dir) expect(u.email).toBeUndefined()
    expect((await call('GET', '/api/users/directory', 'admin')).json()[0].email).toBeTruthy()
    expect((await call('GET', `/api/projects/${pid}/members`, 'field')).json()[0].email).toBeUndefined()
    expect((await call('GET', `/api/projects/${pid}/members`, 'admin')).json()[0].email).toBeTruthy()
  })
})
