import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { openDb, migrate } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-')) })
})

const pdf = await makePdf(3, 'one')
const pdf2 = await makePdf(2, 'revision two')
const pdfOne = await makePdf(1, 'one'), pdfTwo = await makePdf(1, 'two')
function multipartBody(boundary: string) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pageCount"\r\n\r\n3\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="E-101.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf, Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

describe('milestone 1 api', () => {
  let admin = '', projectId = '', docId = ''

  it('sets up the first admin only once', async () => {
    expect((await app.inject('/api/auth/status')).json()).toEqual({ needsSetup: true })
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup',
      payload: { email: 'Boss@x.com', name: 'Boss', password: 'password1', setupCode: 'test-setup-code' } })
    expect(res.statusCode).toBe(200)
    admin = res.json().token
    const again = await app.inject({ method: 'POST', url: '/api/auth/setup',
      payload: { email: 'b@x.com', name: 'B', password: 'password1' } })
    expect(again.statusCode).toBe(409)
  })

  it('rejects bad logins and unauthenticated calls', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'boss@x.com', password: 'nope' } })).statusCode).toBe(401)
    expect((await app.inject('/api/projects')).statusCode).toBe(401)
  })

  it('creates a project and uploads and serves a PDF', async () => {
    const h = { authorization: `Bearer ${admin}` }
    projectId = (await app.inject({ method: 'POST', url: '/api/projects', headers: h, payload: { name: 'School' } })).json().id
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/documents`,
      headers: { ...h, 'content-type': 'multipart/form-data; boundary=XX' }, payload: multipartBody('XX') })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: 'E-101', page_count: 3, revision: 1 })
    docId = res.json().id
    const file = await app.inject({ url: `/api/documents/${docId}/file?token=${admin}` })
    expect(file.rawPayload.equals(pdf)).toBe(true)
  })

  it('enforces project roles', async () => {
    const h = { authorization: `Bearer ${admin}` }
    await app.inject({ method: 'POST', url: '/api/users', headers: h,
      payload: { email: 'tech@x.com', name: 'Tech', password: 'password1' } })
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const vh = { authorization: `Bearer ${viewer}` }
    expect((await app.inject({ url: `/api/projects/${projectId}`, headers: vh })).statusCode).toBe(403)
    await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/members`, headers: h,
      payload: { email: 'tech@x.com', role: 'viewer' } })
    expect((await app.inject({ url: `/api/projects/${projectId}/documents`, headers: vh })).json()).toHaveLength(1)
    expect((await app.inject({ method: 'DELETE', url: `/api/documents/${docId}`, headers: vh })).statusCode).toBe(403)
  })

  it('stores a per-plan device size', async () => {
    const h = { authorization: `Bearer ${admin}` }
    expect((await app.inject({ url: `/api/documents/${docId}`, headers: h })).json().device_scale).toBe(1)
    const r = await app.inject({ method: 'PATCH', url: `/api/documents/${docId}`, headers: h, payload: { device_scale: 1.5 } })
    expect(r.statusCode).toBe(200)
    expect(r.json().device_scale).toBe(1.5)
    expect(r.json().name).toBeTruthy()
    expect((await app.inject({ method: 'PATCH', url: `/api/documents/${docId}`, headers: h, payload: { device_scale: 9 } })).statusCode).toBe(400)
    expect((await app.inject({ url: `/api/documents/${docId}`, headers: h })).json().device_scale).toBe(1.5)
    await app.inject({ method: 'PATCH', url: `/api/documents/${docId}`, headers: h, payload: { device_scale: 1 } })
  })

  it('saves, updates and deletes markups and layers', async () => {
    const h = { authorization: `Bearer ${admin}` }
    const layer = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/layers`, headers: h,
      payload: { name: 'Cameras', color: '#1971c2' } })).json()
    expect(layer.name).toBe('Cameras')
    const id = '11111111-1111-4111-8111-111111111111'
    const url = `/api/documents/${docId}/markups/${id}`
    const body = { page: 1, type: 'rect', geometry: { x: 1, y: 2, width: 3, height: 4, rotation: 0 }, style: { stroke: '#f00' }, layer_id: layer.id }
    expect((await app.inject({ method: 'PUT', url, headers: h, payload: body })).json().version).toBe(1)
    const v2 = (await app.inject({ method: 'PUT', url, headers: h, payload: { ...body, geometry: { ...body.geometry, x: 50 } } })).json()
    expect(v2).toMatchObject({ version: 2, geometry: { x: 50 } })
    expect((await app.inject({ url: `/api/documents/${docId}/markups`, headers: h })).json()).toHaveLength(1)
    await app.inject({ method: 'DELETE', url, headers: h })
    expect((await app.inject({ url: `/api/documents/${docId}/markups`, headers: h })).json()).toHaveLength(0)
    // re-saving (undo of a delete) restores it
    await app.inject({ method: 'PUT', url, headers: h, payload: body })
    expect((await app.inject({ url: `/api/documents/${docId}/markups`, headers: h })).json()).toHaveLength(1)
  })

  it('seeds symbol sets and auto-numbers device tags per project', async () => {
    const h = { authorization: `Bearer ${admin}` }
    const sets = (await app.inject({ url: '/api/symbol-sets', headers: h })).json()
    const cams = sets.find((s: any) => s.tag_prefix === 'CAM')
    expect(cams.has_fov).toBe(true)
    const put = (id: string, extra = {}) => app.inject({ method: 'PUT', url: `/api/documents/${docId}/markups/${id}`, headers: h,
      payload: { page: 1, type: 'device', geometry: { x: 0, y: 0, width: 24, height: 24, rotation: 0 }, symbol_set_id: cams.id, status: 'planned', ...extra } })
    expect((await put('33333333-3333-4333-8333-333333333331')).json().tag).toBe('CAM-01')
    expect((await put('33333333-3333-4333-8333-333333333332', { fields: { ip: '10.0.0.5' } })).json())
      .toMatchObject({ tag: 'CAM-02', fields: { ip: '10.0.0.5' } })
    // existing tags are kept on update
    expect((await put('33333333-3333-4333-8333-333333333331', { tag: 'CAM-01', status: 'installed' })).json())
      .toMatchObject({ tag: 'CAM-01', status: 'installed' })
    expect((await put('33333333-3333-4333-8333-333333333333', { status: 'bogus' })).statusCode).toBe(400)
  })

  it('lets only admins edit symbol sets', async () => {
    const h = { authorization: `Bearer ${admin}` }
    const created = (await app.inject({ method: 'POST', url: '/api/symbol-sets', headers: h,
      payload: { name: 'Intercom', tag_prefix: 'ic', color: '#000', fields: [{ label: 'Station #', type: 'text' }, { label: 'x', type: 'bogus' }] } })).json()
    expect(created).toMatchObject({ tag_prefix: 'IC', fields: [{ key: 'station', label: 'Station #', type: 'text' }] })
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    expect((await app.inject({ method: 'PUT', url: `/api/symbol-sets/${created.id}`,
      headers: { authorization: `Bearer ${viewer}` }, payload: created })).statusCode).toBe(403)
    const bad = await app.inject({ method: 'POST', url: '/api/symbol-sets', headers: h,
      payload: { name: 'X', tag_prefix: 'X', icon: 'javascript:alert(1)' } })
    expect(bad.statusCode).toBe(400)
  })

  it('serves a seeded catalog and numbers tags by device type prefix', async () => {
    const h = { authorization: `Bearer ${admin}` }
    const cat = (await app.inject({ url: '/api/catalog', headers: h })).json()
    const fire = (await app.inject({ url: '/api/symbol-sets', headers: h })).json().find((s: any) => s.tag_prefix === 'FA')
    const smoke = cat.device_types.find((t: any) => t.name === 'Smoke Detector')
    expect(smoke).toMatchObject({ symbol_set_id: fire.id, tag_prefix: 'SD' })
    const prod = cat.products.find((p: any) => p.id === smoke.default_product_id)
    expect(prod).toMatchObject({ model: 'PAD100-PHOTO', unit_cost: 62 })
    expect(prod.accessories).toHaveLength(1)
    const put = (id: string, extra = {}) => app.inject({ method: 'PUT', url: `/api/documents/${docId}/markups/${id}`, headers: h,
      payload: { page: 1, type: 'device', geometry: { x: 0, y: 0, width: 24, height: 24, rotation: 0 }, symbol_set_id: fire.id,
        device_type_id: smoke.id, product_id: prod.id, ...extra } })
    expect((await put('44444444-4444-4444-8444-444444444441')).json())
      .toMatchObject({ tag: 'SD-01', device_type_id: smoke.id, product_id: prod.id })
    expect((await put('44444444-4444-4444-8444-444444444442')).json().tag).toBe('SD-02')
    // type without its own prefix falls back to the set prefix
    const noPrefix = cat.device_types.find((t: any) => t.name === 'IP Camera')
    const cams = (await app.inject({ url: '/api/symbol-sets', headers: h })).json().find((s: any) => s.tag_prefix === 'CAM')
    expect((await put('44444444-4444-4444-8444-444444444443', { symbol_set_id: cams.id, device_type_id: noPrefix.id, product_id: null })).json().tag)
      .toMatch(/^CAM-/)
    // a type from another set is rejected
    expect((await put('44444444-4444-4444-8444-444444444444', { device_type_id: noPrefix.id })).statusCode).toBe(400)
    // a product that no longer exists falls back to none instead of failing the save
    const gone = await put('44444444-4444-4444-8444-444444444445', { product_id: '55555555-5555-4555-8555-555555555555' })
    expect(gone.statusCode).toBe(200)
    expect(gone.json().product_id).toBeNull()
  })

  it('lets admins manage device types and products, and keeps used products', async () => {
    const h = { authorization: `Bearer ${admin}` }
    const sets = (await app.inject({ url: '/api/symbol-sets', headers: h })).json()
    const net = sets.find((s: any) => s.name === 'Network')
    const t = (await app.inject({ method: 'POST', url: `/api/symbol-sets/${net.id}/device-types`, headers: h,
      payload: { name: 'Switch', tag_prefix: 'sw', fields: [{ label: 'Ports', type: 'number' }] } })).json()
    expect(t).toMatchObject({ name: 'Switch', tag_prefix: 'SW', fields: [{ key: 'ports', label: 'Ports', type: 'number' }] })
    // mount shape: defaults to ceiling, validated to the 3 values, kept when a save does not send it
    expect(t.mount).toBe('ceiling')
    const putType = (payload: any) => app.inject({ method: 'PUT', url: `/api/device-types/${t.id}`, headers: h, payload: { name: 'Switch', ...payload } })
    expect((await putType({ mount: 'wall' })).json().mount).toBe('wall')
    expect((await putType({})).json().mount).toBe('wall')
    expect((await putType({ mount: 'square' })).json().mount).toBe('square')
    expect((await putType({ mount: 'ceiling' })).json().mount).toBe('ceiling')
    expect((await putType({ mount: 'floor' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/symbol-sets/${net.id}/device-types`, headers: h, payload: { name: 'Bad', mount: 'sideways' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/symbol-sets/${net.id}/device-types`, headers: h, payload: { name: 'Wall box', mount: 'wall' } })).json().mount).toBe('wall')
    const acc = (await app.inject({ method: 'POST', url: '/api/products', headers: h,
      payload: { kind: 'accessory', manufacturer: 'Generic', model: 'SFP', unit_cost: '12.5', labor_hours: 0.1 } })).json()
    expect(acc).toMatchObject({ kind: 'accessory', device_type_id: null, unit_cost: 12.5 })
    const p = (await app.inject({ method: 'POST', url: '/api/products', headers: h,
      payload: { device_type_id: t.id, manufacturer: 'Cisco', model: 'C9200', unit_cost: 900, labor_hours: 2,
        accessories: [{ product_id: acc.id, qty: 2 }, { name: 'Rack kit', unit_cost: 5, qty: 1 }, { qty: 3 }] } })).json()
    expect(p.accessories).toEqual([{ product_id: acc.id, qty: 2 }, { name: 'Rack kit', unit_cost: 5, labor_hours: 0, qty: 1 }])
    // first product becomes the type default
    const cat = (await app.inject({ url: '/api/catalog', headers: h })).json()
    expect(cat.device_types.find((x: any) => x.id === t.id).default_product_id).toBe(p.id)
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const vh = { authorization: `Bearer ${viewer}` }
    expect((await app.inject({ url: '/api/catalog', headers: vh })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/products', headers: vh, payload: p })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: `/api/device-types/${t.id}`, headers: vh, payload: t })).statusCode).toBe(403)
    // used product is deactivated, unused is removed
    await app.inject({ method: 'PUT', url: `/api/documents/${docId}/markups/66666666-6666-4666-8666-666666666661`, headers: h,
      payload: { page: 1, type: 'device', geometry: {}, symbol_set_id: net.id, device_type_id: t.id, product_id: p.id } })
    expect((await app.inject({ method: 'DELETE', url: `/api/products/${p.id}`, headers: h })).json()).toMatchObject({ deactivated: true })
    expect((await app.inject({ method: 'DELETE', url: `/api/products/${acc.id}`, headers: h })).json()).toMatchObject({ deactivated: false })
    const after = (await app.inject({ url: '/api/catalog', headers: h })).json()
    expect(after.products.find((x: any) => x.id === p.id).active).toBe(false)
    expect(after.products.find((x: any) => x.id === acc.id)).toBeUndefined()
  })

  it('saves Revu converter mappings per organization', async () => {
    const h = { authorization: `Bearer ${admin}` }
    const sets = (await app.inject({ url: '/api/symbol-sets', headers: h })).json()
    const net = sets.find((s: any) => s.name === 'Network')
    const put = (payload: unknown, headers = h) => app.inject({ method: 'PUT', url: '/api/revu-mappings', headers, payload: payload as any })
    expect((await app.inject({ url: '/api/revu-mappings', headers: h })).json()).toEqual([])
    const r = await put({ mappings: [
      { signature: 'Fire | SD-1', action: 'device', symbol_set_id: net.id },
      { signature: 'Data | Text Box', action: 'plain' },
      { signature: 'Fire | junk', action: 'skip', symbol_set_id: net.id },
    ] })
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json()
    expect(rows.map((x: any) => [x.signature, x.action, x.symbol_set_id]).sort((a: any, b: any) => (a[0] < b[0] ? -1 : 1))).toEqual([
      ['Data | Text Box', 'plain', null], ['Fire | SD-1', 'device', net.id], ['Fire | junk', 'skip', null]])
    // upsert replaces
    await put({ mappings: [{ signature: 'Fire | SD-1', action: 'skip' }] })
    expect((await app.inject({ url: '/api/revu-mappings', headers: h })).json().find((x: any) => x.signature === 'Fire | SD-1')).toMatchObject({ action: 'skip', symbol_set_id: null })
    // validation
    expect((await put({ mappings: [{ signature: 'x', action: 'device' }] })).statusCode).toBe(400)
    expect((await put({ mappings: [{ signature: 'x', action: 'bogus' }] })).statusCode).toBe(400)
    expect((await put({ mappings: [{ signature: 'x', action: 'device', symbol_set_id: '77777777-7777-4777-8777-777777777777' }] })).statusCode).toBe(400)
    expect((await put({ nope: 1 })).statusCode).toBe(400)
    // viewers cannot save
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const vr = await put({ mappings: [{ signature: 'v', action: 'plain' }] }, { authorization: `Bearer ${viewer}` })
    expect(vr.statusCode).toBe(403)
    expect((await app.inject({ url: '/api/revu-mappings' })).statusCode).toBe(401)
  })

  it('blocks viewers from editing markups', async () => {
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const res = await app.inject({ method: 'PUT', url: `/api/documents/${docId}/markups/22222222-2222-4222-8222-222222222222`,
      headers: { authorization: `Bearer ${viewer}` }, payload: { page: 1, type: 'line', geometry: {} } })
    expect(res.statusCode).toBe(403)
  })

  it('stores per-page drawing scales', async () => {
    const h = { authorization: `Bearer ${admin}` }
    const base = `/api/documents/${docId}/scales`
    expect((await app.inject({ url: base, headers: h })).json()).toEqual([])
    const set = await app.inject({ method: 'PUT', url: `${base}/2`, headers: h,
      payload: { points_per_foot: 9, label: '1/8" = 1\'-0"' } })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ page: 2, points_per_foot: 9, label: '1/8" = 1\'-0"' })
    expect(set.json().updated_at).toBeTruthy()
    const over = await app.inject({ method: 'PUT', url: `${base}/2`, headers: h, payload: { points_per_foot: 18 } })
    expect(over.json()).toMatchObject({ page: 2, points_per_foot: 18, label: '' })
    const bulk = await app.inject({ method: 'PUT', url: base, headers: h,
      payload: { points_per_foot: 6, label: 'Calibrated', pages: [3, 1, 2] } })
    expect(bulk.json().map((r: any) => r.page)).toEqual([1, 2, 3])
    const all = (await app.inject({ url: base, headers: h })).json()
    expect(all).toHaveLength(3)
    expect(all.every((r: any) => r.points_per_foot === 6 && r.label === 'Calibrated')).toBe(true)
    expect((await app.inject({ method: 'DELETE', url: `${base}/2`, headers: h })).json()).toEqual({ ok: true })
    expect((await app.inject({ url: base, headers: h })).json().map((r: any) => r.page)).toEqual([1, 3])

    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const vh = { authorization: `Bearer ${viewer}` }
    expect((await app.inject({ url: base, headers: vh })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: `${base}/1`, headers: vh, payload: { points_per_foot: 5 } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `${base}/1`, headers: vh })).statusCode).toBe(403)

    for (const [url, payload] of [
      [`${base}/0`, { points_per_foot: 5 }], [`${base}/1.5`, { points_per_foot: 5 }], [`${base}/x`, { points_per_foot: 5 }],
      [`${base}/1`, { points_per_foot: 0 }], [`${base}/1`, { points_per_foot: -1 }], [`${base}/1`, { points_per_foot: 100000 }],
      [`${base}/1`, { points_per_foot: '5' }], [`${base}/1`, {}], [base, { points_per_foot: 5, pages: [] }],
      [base, { points_per_foot: 5, pages: [0] }], [base, { points_per_foot: 0, pages: [1] }],
    ] as [string, any][])
      expect((await app.inject({ method: 'PUT', url, headers: h, payload })).statusCode, url + JSON.stringify(payload)).toBe(400)
  })

  describe('markup history', () => {
    const mid = '55555555-5555-4555-8555-555555555555'
    let sam = ''
    const hist = async (token = admin) => (await app.inject({ url: `/api/markups/${mid}/history`, headers: { authorization: `Bearer ${token}` } })).json()
    const put = (token: string, extra: any = {}) => app.inject({ method: 'PUT', url: `/api/documents/${docId}/markups/${mid}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { page: 1, type: 'device', geometry: { x: 0, y: 0 }, status: 'planned', ...extra } })

    it('records created, coalesces typing, and tracks status', async () => {
      const h = { authorization: `Bearer ${admin}` }
      await app.inject({ method: 'POST', url: '/api/users', headers: h, payload: { email: 'sam@x.com', name: 'Sam', password: 'password1' } })
      await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/members`, headers: h, payload: { email: 'sam@x.com', role: 'editor' } })
      sam = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'sam@x.com', password: 'password1' } })).json().token
      await put(admin)
      await put(admin, { fields: { ip: '10' } })
      await put(admin, { fields: { ip: '10.0.0.7' } })
      let ev = await hist()
      expect(ev.map((e: any) => e.action)).toEqual(['updated', 'created'])
      expect(ev[0].changes).toEqual({ 'fields.ip': { from: null, to: '10.0.0.7' } })
      expect(ev[0].user).toMatchObject({ name: 'Boss', email: 'boss@x.com' })
      await put(admin, { fields: { ip: '10.0.0.7' }, status: 'installed' })
      ev = await hist()
      expect(ev).toHaveLength(2)
      expect(ev[0].changes).toEqual({ 'fields.ip': { from: null, to: '10.0.0.7' }, status: { from: 'planned', to: 'installed' } })
      // a no-op save writes nothing
      await put(admin, { fields: { ip: '10.0.0.7' }, status: 'installed' })
      expect(await hist()).toHaveLength(2)
    })

    it('a different user gets a separate event; list has names', async () => {
      await put(sam, { fields: { ip: '10.0.0.8' }, status: 'installed' })
      const ev = await hist(sam)
      expect(ev).toHaveLength(3)
      expect(ev[0]).toMatchObject({ action: 'updated', changes: { 'fields.ip': { from: '10.0.0.7', to: '10.0.0.8' } }, user: { name: 'Sam' } })
      expect(ev[1].user.name).toBe('Boss')
      const list = (await app.inject({ url: `/api/documents/${docId}/markups`, headers: { authorization: `Bearer ${admin}` } })).json()
      expect(list.find((m: any) => m.id === mid)).toMatchObject({ created_by_name: 'Boss', updated_by_name: 'Sam' })
    })

    it('records photos and deletion; viewers can read history', async () => {
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1])
      const aid = '66666666-6666-4666-8666-666666666666'
      const b = 'HB'
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${aid}\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nRack\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        jpg, Buffer.from(`\r\n--${b}--\r\n`)])
      const post = () => app.inject({ method: 'POST', url: `/api/markups/${mid}/attachments`,
        headers: { authorization: `Bearer ${admin}`, 'content-type': `multipart/form-data; boundary=${b}` }, payload: body })
      expect((await post()).statusCode).toBe(200)
      expect((await post()).statusCode).toBe(200) // idempotent re-POST adds no event
      let ev = await hist()
      expect(ev.filter((e: any) => e.action === 'photo_added')).toHaveLength(1)
      expect(ev[0]).toMatchObject({ action: 'photo_added', changes: { attachment_id: aid, caption: 'Rack' } })
      await app.inject({ method: 'DELETE', url: `/api/attachments/${aid}`, headers: { authorization: `Bearer ${admin}` } })
      await app.inject({ method: 'DELETE', url: `/api/documents/${docId}/markups/${mid}`, headers: { authorization: `Bearer ${admin}` } })
      ev = await hist()
      expect(ev.slice(0, 2).map((e: any) => e.action)).toEqual(['deleted', 'photo_deleted'])
      const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
      expect((await app.inject({ url: `/api/markups/${mid}/history`, headers: { authorization: `Bearer ${viewer}` } })).statusCode).toBe(200)
      await put(admin)
      expect((await hist())[0].action).toBe('restored')
    })
  })

  describe('project-wide reads', () => {
    it('aggregates markups across documents, filters by type, counts photos, enforces roles', async () => {
      const h = { authorization: `Bearer ${admin}` }
      const doc2 = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/documents`,
        headers: { ...h, 'content-type': 'multipart/form-data; boundary=XX' }, payload: multipartBody('XX') })).json().id
      const m2 = '77777777-7777-4777-8777-777777777777'
      await app.inject({ method: 'PUT', url: `/api/documents/${doc2}/markups/${m2}`, headers: h,
        payload: { page: 2, type: 'device', geometry: { x: 0, y: 0, width: 24, height: 24, rotation: 0 } } })
      const b = 'PB2', jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
      const aid = '77777777-7777-4777-8777-777777777778'
      const up = await app.inject({ method: 'POST', url: `/api/markups/${m2}/attachments`,
        headers: { ...h, 'content-type': `multipart/form-data; boundary=${b}` },
        payload: Buffer.concat([
          Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${aid}\r\n`),
          Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
          jpg, Buffer.from(`\r\n--${b}--\r\n`)]) })
      expect(up.statusCode).toBe(200)

      const all = (await app.inject({ url: `/api/projects/${projectId}/markups`, headers: h })).json()
      const docIds = new Set(all.map((m: any) => m.document_id))
      expect(docIds.has(docId) && docIds.has(doc2)).toBe(true)
      expect(all.every((m: any) => m.document_name === 'E-101' && typeof m.created_by_name === 'string')).toBe(true)
      expect(all.find((m: any) => m.id === m2)).toMatchObject({ photo_count: 1, page: 2, type: 'device' })
      expect(all.filter((m: any) => m.id !== m2).every((m: any) => m.photo_count === 0)).toBe(true)

      const devices = (await app.inject({ url: `/api/projects/${projectId}/markups?type=device`, headers: h })).json()
      expect(devices.length).toBeGreaterThan(0)
      expect(devices.length).toBeLessThan(all.length)
      expect(devices.every((m: any) => m.type === 'device')).toBe(true)

      const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
      const vh = { authorization: `Bearer ${viewer}` }
      expect((await app.inject({ url: `/api/projects/${projectId}/markups`, headers: vh })).statusCode).toBe(200)
      expect((await app.inject({ url: `/api/projects/${projectId}/scales`, headers: vh })).statusCode).toBe(200)

      await app.inject({ method: 'POST', url: '/api/users', headers: h,
        payload: { email: 'out@x.com', name: 'Out', password: 'password1' } })
      const out = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'out@x.com', password: 'password1' } })).json().token
      const oh = { authorization: `Bearer ${out}` }
      expect((await app.inject({ url: `/api/projects/${projectId}/markups`, headers: oh })).statusCode).toBe(403)
      expect((await app.inject({ url: `/api/projects/${projectId}/scales`, headers: oh })).statusCode).toBe(403)

      // scales
      await app.inject({ method: 'PUT', url: `/api/documents/${doc2}/scales/2`, headers: h, payload: { points_per_foot: 12, label: '1/6' } })
      await app.inject({ method: 'PUT', url: `/api/documents/${docId}/scales/1`, headers: h, payload: { points_per_foot: 6 } })
      const scales = (await app.inject({ url: `/api/projects/${projectId}/scales`, headers: h })).json()
      expect(scales).toContainEqual({ document_id: doc2, page: 2, points_per_foot: 12, label: '1/6' })
      expect(scales).toContainEqual({ document_id: docId, page: 1, points_per_foot: 6, label: '' })
    })
  })

  describe('photo attachments', () => {
    const mk = '11111111-1111-4111-8111-111111111111'
    const aid = '44444444-4444-4444-8444-444444444444'
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    const png2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
    const photoBody = (b: string, fields: Record<string, string>, data: Buffer, type = 'image/jpeg') => Buffer.concat([
      ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="../../x.jpg"\r\nContent-Type: ${type}\r\n\r\n`),
      data, Buffer.from(`\r\n--${b}--\r\n`),
    ])
    const send = (method: 'POST' | 'PUT', url: string, token: string, fields: Record<string, string>, data: Buffer, type?: string) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=PB' },
        payload: photoBody('PB', fields, data, type) })
    const login = async () => (await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'tech@x.com', password: 'password1' } })).json().token

    it('uploads, lists, patches, annotates, serves and deletes', async () => {
      const h = { authorization: `Bearer ${admin}` }
      const up = await send('POST', `/api/markups/${mk}/attachments`, admin, { id: aid, caption: 'Before', width: '640', height: '480' }, jpg)
      expect(up.statusCode).toBe(200)
      expect(up.json()).toMatchObject({ id: aid, markup_id: mk, caption: 'Before', width: 640, height: 480, has_annotation: false })
      expect((await app.inject({ url: `/api/markups/${mk}/attachments`, headers: h })).json()).toHaveLength(1)
      expect((await app.inject({ method: 'PATCH', url: `/api/attachments/${aid}`, headers: h, payload: { caption: 'After' } })).json().caption).toBe('After')

      const file = (q = '') => app.inject({ url: `/api/attachments/${aid}/file?token=${admin}${q}` })
      const orig = await file()
      expect(orig.rawPayload.equals(jpg)).toBe(true)
      expect(orig.headers['content-type']).toBe('image/jpeg')
      expect(orig.headers['cache-control']).toBe('private, max-age=31536000, immutable')

      const ann = await send('PUT', `/api/attachments/${aid}/annotated`, admin, {}, png2, 'image/png')
      expect(ann.json().has_annotation).toBe(true)
      const ann2 = await send('PUT', `/api/attachments/${aid}/annotated`, admin, {}, Buffer.concat([png2, png2]), 'image/png')
      expect(ann2.statusCode).toBe(200)
      const def = await file()
      expect(def.rawPayload.equals(Buffer.concat([png2, png2]))).toBe(true)
      expect(def.headers['content-type']).toBe('image/png')
      expect((await file('&variant=original')).rawPayload.equals(jpg)).toBe(true)

      expect((await app.inject({ method: 'DELETE', url: `/api/attachments/${aid}`, headers: h })).json()).toEqual({ ok: true })
      expect((await app.inject({ url: `/api/markups/${mk}/attachments`, headers: h })).json()).toHaveLength(0)
      expect((await file()).statusCode).toBe(404)
    })

    it('is idempotent on re-POST of the same id', async () => {
      const id = '44444444-4444-4444-8444-444444444445'
      const a = await send('POST', `/api/markups/${mk}/attachments`, admin, { id, caption: 'one' }, jpg)
      const b = await send('POST', `/api/markups/${mk}/attachments`, admin, { id, caption: 'two' }, jpg)
      expect(b.statusCode).toBe(200)
      expect(b.json()).toEqual(a.json())
      const list = (await app.inject({ url: `/api/markups/${mk}/attachments`, headers: { authorization: `Bearer ${admin}` } })).json()
      expect(list).toHaveLength(1)
    })

    it('rejects viewers, bad mime types and unknown markups', async () => {
      const viewer = await login()
      const id = '44444444-4444-4444-8444-444444444446'
      expect((await send('POST', `/api/markups/${mk}/attachments`, viewer, { id }, jpg)).statusCode).toBe(403)
      expect((await app.inject({ url: `/api/markups/${mk}/attachments`, headers: { authorization: `Bearer ${viewer}` } })).statusCode).toBe(200)
      expect((await send('POST', `/api/markups/${mk}/attachments`, admin, { id }, pdf, 'application/pdf')).statusCode).toBe(400)
      expect((await send('POST', '/api/markups/99999999-9999-4999-8999-999999999999/attachments', admin, { id }, jpg)).statusCode).toBe(404)
    })
  })
})

describe('document revisions', () => {

  const body = (pages: number, bytes: Buffer, b = 'RV') => Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="pageCount"\r\n\r\n${pages}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="E-101-B.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${b}--\r\n`)])
  const send = (url: string, token: string, payload: Buffer) => app.inject({ method: 'POST', url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=RV' }, payload })
  let admin = '', viewer = '', doc = '', rev1 = ''

  it('creates a document, then adds a revision that becomes current while the old one stays', async () => {
    admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@x.com', password: 'password1' } })).json().token
    viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const h = { authorization: `Bearer ${admin}` }
    const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: h, payload: { name: 'Rev project' } })).json().id
    await app.inject({ method: 'PUT', url: `/api/projects/${project}/members`, headers: h, payload: { email: 'tech@x.com', role: 'viewer' } })
    const created = (await send(`/api/projects/${project}/documents`, admin, body(3, pdf))).json()
    doc = created.id; rev1 = created.revision_id
    // a markup on page 3 will be orphaned by a 2-page revision
    const put = await app.inject({ method: 'PUT', url: `/api/documents/${doc}/markups/abababab-5555-4555-8555-555555555555`, headers: h,
      payload: { page: 3, type: 'rect', geometry: { x: 1, y: 1, width: 5, height: 5, rotation: 0 } } })

    expect(put.statusCode, put.body).toBe(200)
    const res = await send(`/api/documents/${doc}/revisions`, admin, body(2, pdf2))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ revision: 2, page_count: 2, orphaned_markups: 1, orphaned_pages: [3] })

    const list = (await app.inject({ url: `/api/documents/${doc}/revisions`, headers: h })).json()
    expect(list.map((r: any) => r.revision)).toEqual([2, 1])
    expect(list[0].uploaded_by_name).toBe('Boss')

    const cur = await app.inject({ url: `/api/documents/${doc}/file?token=${admin}` })
    expect(cur.rawPayload.equals(pdf2)).toBe(true)
    const old = await app.inject({ url: `/api/documents/${doc}/file?token=${admin}&revision=${rev1}` })
    expect(old.rawPayload.equals(pdf)).toBe(true)
    // markups survive (flagged by page count on the client)
    expect((await app.inject({ url: `/api/documents/${doc}/markups`, headers: h })).json()).toHaveLength(1)
    const docs = (await app.inject({ url: `/api/projects/${project}/documents`, headers: h })).json()
    expect(docs[0]).toMatchObject({ revision: 2, page_count: 2 })
  })

  it('rejects viewers, non-PDFs, unknown documents and bad revision ids', async () => {
    expect((await send(`/api/documents/${doc}/revisions`, viewer, body(1, pdf2))).statusCode).toBe(403)
    expect((await app.inject({ url: `/api/documents/${doc}/revisions`, headers: { authorization: `Bearer ${viewer}` } })).statusCode).toBe(200)
    const txt = Buffer.concat([
      Buffer.from('--RV\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--RV--\r\n')])
    expect((await send(`/api/documents/${doc}/revisions`, admin, txt)).statusCode).toBe(400)
    expect((await send('/api/documents/99999999-9999-4999-8999-999999999999/revisions', admin, body(1, pdf2))).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/documents/${doc}/file?token=${admin}&revision=nope` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/documents/${doc}/file?token=${admin}&revision=99999999-9999-4999-8999-999999999999` })).statusCode).toBe(404)
  })
})

describe('health', () => {
  it('reports db ok without auth', async () => {
    const res = await app.inject('/api/health')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' })
  })
})

describe('user prefs', () => {
  let a = '', b = ''
  it('stores prefs per user and replaces them on PUT', async () => {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@x.com', password: 'password1' } })
    a = setup.json().token
    await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${a}` },
      payload: { email: 'prefs@x.com', name: 'Prefs', password: 'password1' } })
    b = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'prefs@x.com', password: 'password1' } })).json().token
    const ha = { authorization: `Bearer ${a}` }, hb = { authorization: `Bearer ${b}` }
    expect((await app.inject({ url: '/api/me/prefs', headers: ha })).json()).toEqual({ prefs: {}, updated_at: null })
    const body = { prefs: { hotkeys: { 'tool.rect': 'Shift+R' }, favorites: ['tool:line'], listColumns: null } }
    const put = await app.inject({ method: 'PUT', url: '/api/me/prefs', headers: ha, payload: body })
    expect(put.statusCode).toBe(200)
    expect(put.json().prefs).toEqual(body.prefs)
    expect((await app.inject({ url: '/api/me/prefs', headers: ha })).json().prefs).toEqual(body.prefs)
    // another user's row is separate
    expect((await app.inject({ url: '/api/me/prefs', headers: hb })).json().prefs).toEqual({})
    await app.inject({ method: 'PUT', url: '/api/me/prefs', headers: ha, payload: { prefs: { favorites: [] } } })
    expect((await app.inject({ url: '/api/me/prefs', headers: ha })).json().prefs).toEqual({ favorites: [] })
  })

  it('requires auth and an object body', async () => {
    expect((await app.inject('/api/me/prefs')).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/api/me/prefs', payload: { prefs: {} } })).statusCode).toBe(401)
    const h = { authorization: `Bearer ${a}` }
    expect((await app.inject({ method: 'PUT', url: '/api/me/prefs', headers: h, payload: { prefs: [1] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/api/me/prefs', headers: h, payload: { prefs: 'x' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/api/me/prefs', headers: h, payload: {} })).statusCode).toBe(400)
    const big = { prefs: { blob: 'x'.repeat(300 * 1024) } }
    expect((await app.inject({ method: 'PUT', url: '/api/me/prefs', headers: h, payload: big })).statusCode).toBe(413)
  })
})

describe('milestone 12 revision snapshots and page tools', () => {
  const boundary = 'M12'
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  const filePart = (bytes: Uint8Array) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)])
  const multipart = (fields: Record<string, string>, bytes: Uint8Array) =>
    Buffer.concat([...Object.entries(fields).map(([k, v]) => Buffer.from(field(k, v))), filePart(bytes)])
  const send = (url: string, token: string, payload: Buffer) => app.inject({ method: 'POST', url,
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  async function pdfOf(sizes: number[]) {
    const { PDFDocument } = await import('pdf-lib')
    const d = await PDFDocument.create()
    for (const w of sizes) d.addPage([w, 100])
    return d.save()
  }
  let admin = '', viewer = '', h: Record<string, string> = {}, doc = '', rev1 = ''
  const mid = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
  const put = (id: string, page: number, extra: object = {}) => app.inject({ method: 'PUT', url: `/api/documents/${doc}/markups/${id}`, headers: h,
    payload: { page, type: 'rect', geometry: { x: 10, y: 20, width: 30, height: 40, rotation: 0 }, ...extra } })
  const live = async () => (await app.inject({ url: `/api/documents/${doc}/markups`, headers: h })).json() as any[]
  const pageOf = async () => Object.fromEntries((await live()).map(m => [m.id, m.page]))

  it('issues a revision that freezes markups, and an upload freezes the superseded one', async () => {
    admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@x.com', password: 'password1' } })).json().token
    viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    h = { authorization: `Bearer ${admin}` }
    const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: h, payload: { name: 'M12' } })).json().id
    await app.inject({ method: 'PUT', url: `/api/projects/${project}/members`, headers: h, payload: { email: 'tech@x.com', role: 'viewer' } })
    const created = (await send(`/api/projects/${project}/documents`, admin, multipart({ pageCount: '3' }, await pdfOf([100, 200, 300])))).json()
    doc = created.id; rev1 = created.revision_id
    expect((await put(mid(1), 1)).statusCode).toBe(200)
    expect((await put(mid(2), 2)).statusCode).toBe(200)
    expect((await put(mid(3), 3)).statusCode).toBe(200)

    const issue = (p: object, token = admin) => app.inject({ method: 'POST', url: `/api/documents/${doc}/revisions/issue`, headers: { authorization: `Bearer ${token}` }, payload: p })
    expect((await issue({ label: '' })).statusCode).toBe(400)
    expect((await issue({ label: 'Rev A', note: 'x' }, viewer)).statusCode).toBe(403)
    const issued = await issue({ label: 'Rev 1 - Issued', note: 'for permit' })
    expect(issued.statusCode, issued.body).toBe(200)
    expect(issued.json()).toMatchObject({ kind: 'issued', label: 'Rev 1 - Issued', note: 'for permit', revision: 2 })

    // edit after the issue; the issued snapshot must not change
    await put(mid(1), 1, { geometry: { x: 999, y: 20, width: 30, height: 40, rotation: 0 } })
    const snap = (await app.inject({ url: `/api/documents/${doc}/revisions/${issued.json().id}`, headers: { authorization: `Bearer ${viewer}` } })).json()
    expect(snap.live).toBe(false)
    expect(snap.markups).toHaveLength(3)
    expect(snap.markups.find((m: any) => m.id === mid(1)).geometry.x).toBe(10)
    // the revision it was issued from was frozen too
    const first = (await app.inject({ url: `/api/documents/${doc}/revisions/${rev1}`, headers: h })).json()
    expect(first.live).toBe(false)
    expect(first.markups).toHaveLength(3)

    // the issued revision is frozen, so an upload leaves its snapshot alone; the new current one stays live
    const up = await send(`/api/documents/${doc}/revisions`, admin, multipart({ pageCount: '3' }, await pdfOf([100, 200, 300])))
    expect(up.json()).toMatchObject({ revision: 3, kind: 'upload' })
    const latest = (await app.inject({ url: `/api/documents/${doc}/revisions/${up.json().id}`, headers: h })).json()
    expect(latest.live).toBe(true)
    expect(latest.markups.find((m: any) => m.id === mid(1)).geometry.x).toBe(999)
    // a following upload freezes revision 3 with the edit
    await send(`/api/documents/${doc}/revisions`, admin, multipart({ pageCount: '3' }, await pdfOf([100, 200, 300])))
    const frozen = (await app.inject({ url: `/api/documents/${doc}/revisions/${up.json().id}`, headers: h })).json()
    expect(frozen.live).toBe(false)
    expect(frozen.markups.find((m: any) => m.id === mid(1)).geometry.x).toBe(999)

    const list = (await app.inject({ url: `/api/documents/${doc}/revisions`, headers: h })).json()
    expect(list.map((r: any) => [r.revision, r.kind])).toEqual([[4, 'upload'], [3, 'upload'], [2, 'issued'], [1, 'upload']])
    expect(list[2]).toMatchObject({ label: 'Rev 1 - Issued', has_snapshot: true })
    expect(list[0].has_snapshot).toBe(false)
    // file per revision
    const f = await app.inject({ url: `/api/documents/${doc}/revisions/${issued.json().id}/file?token=${admin}` })
    expect(f.statusCode).toBe(200)
    expect(f.headers['content-type']).toBe('application/pdf')
    expect((await app.inject({ url: `/api/documents/${doc}/revisions/nope`, headers: h })).statusCode).toBe(404)
  })

  it('deletes a page: later markups and scales move up, the deleted page stays in the snapshot only', async () => {
    const del = (pages: number[], token = admin) => app.inject({ method: 'POST', url: `/api/documents/${doc}/pages/delete`, headers: { authorization: `Bearer ${token}` }, payload: { pages } })
    await app.inject({ method: 'PUT', url: `/api/documents/${doc}/scales/3`, headers: h, payload: { points_per_foot: 12, label: '1/8' } })
    expect((await del([2], viewer)).statusCode).toBe(403)
    expect((await del([1, 2, 3])).statusCode).toBe(400)
    const res = await del([2])
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ kind: 'upload', page_count: 2, deleted_markups: 1, mapping: [1, null, 2] })
    expect(await pageOf()).toEqual({ [mid(1)]: 1, [mid(3)]: 2 })
    const scales = (await app.inject({ url: `/api/documents/${doc}/scales`, headers: h })).json()
    expect(scales).toMatchObject([{ page: 2, points_per_foot: 12 }])
    const list = (await app.inject({ url: `/api/documents/${doc}/revisions`, headers: h })).json()
    const before = (await app.inject({ url: `/api/documents/${doc}/revisions/${list[1].id}`, headers: h })).json()
    expect(before.live).toBe(false)
    expect(before.markups.map((m: any) => m.page).sort()).toEqual([1, 2, 3])
    const file = await app.inject({ url: `/api/documents/${doc}/file?token=${admin}` })
    const { PDFDocument } = await import('pdf-lib')
    expect((await PDFDocument.load(file.rawPayload)).getPageCount()).toBe(2)
  })

  it('inserts, reorders and replaces pages with markups following', async () => {
    const ins = await send(`/api/documents/${doc}/pages/insert`, admin, multipart({ at: '1' }, await pdfOf([50])))
    expect(ins.statusCode, ins.body).toBe(200)
    expect(ins.json()).toMatchObject({ page_count: 3, mapping: [2, 3] })
    expect(await pageOf()).toEqual({ [mid(1)]: 2, [mid(3)]: 3 })
    expect((await send(`/api/documents/${doc}/pages/insert`, admin, multipart({ at: '9' }, await pdfOf([50])))).statusCode).toBe(400)

    const re = await app.inject({ method: 'POST', url: `/api/documents/${doc}/pages/reorder`, headers: h, payload: { order: [3, 1, 2] } })
    expect(re.json().mapping).toEqual([2, 3, 1])
    expect(await pageOf()).toEqual({ [mid(1)]: 3, [mid(3)]: 1 })
    expect((await app.inject({ method: 'POST', url: `/api/documents/${doc}/pages/reorder`, headers: h, payload: { order: [1, 1, 2] } })).statusCode).toBe(400)

    const rep = await send(`/api/documents/${doc}/pages/replace`, admin, multipart({ pages: '1' }, await pdfOf([77])))
    expect(rep.statusCode, rep.body).toBe(200)
    expect(await pageOf()).toEqual({ [mid(1)]: 3, [mid(3)]: 1 })
    const { PDFDocument } = await import('pdf-lib')
    const file = await app.inject({ url: `/api/documents/${doc}/file?token=${admin}` })
    expect((await PDFDocument.load(file.rawPayload)).getPages().map(p => p.getWidth())).toEqual([77, 50, 100])
  })

  it('rotates a page and turns its markups with it', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/documents/${doc}/pages/rotate`, headers: h, payload: { pages: [3], degrees: 90 } })
    expect(res.statusCode, res.body).toBe(200)
    const m = (await live()).find(x => x.id === mid(1))
    expect(m.geometry).toMatchObject({ x: 80, y: 999, rotation: 90 }) // page 3 is 100x100 and the markup sits at (999,20) after the earlier edit
    const { PDFDocument } = await import('pdf-lib')
    const file = await app.inject({ url: `/api/documents/${doc}/file?token=${admin}` })
    expect((await PDFDocument.load(file.rawPayload)).getPage(2).getRotation().angle).toBe(90)
  })
})

describe('restore a revision and device type order', () => {
  const mp = (pages: number, bytes: Buffer, b = 'MC') => Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="pageCount"\r\n\r\n${pages}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="P.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${b}--\r\n`)])
  const send = (url: string, token: string, payload: Buffer) => app.inject({ method: 'POST', url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=MC' }, payload })
  const idOf = (n: number) => `${String(n).repeat(8)}-7a7a-47a7-87a7-a7a7a7a7a7a7`

  it('makes an older revision current: snapshots first, restores markups and scales, keeps newer revisions', async () => {
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@x.com', password: 'password1' } })).json().token
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const h = { authorization: `Bearer ${admin}` }
    const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: h, payload: { name: 'Restore project' } })).json().id
    await app.inject({ method: 'PUT', url: `/api/projects/${project}/members`, headers: h, payload: { email: 'tech@x.com', role: 'viewer' } })
    const doc = (await send(`/api/projects/${project}/documents`, admin, mp(1, pdfOne))).json().id
    const put = (id: string, x: number) => app.inject({ method: 'PUT', url: `/api/documents/${doc}/markups/${id}`, headers: h,
      payload: { page: 1, type: 'rect', geometry: { x, y: 0, width: 5, height: 5, rotation: 0 } } })
    const live = async () => (await app.inject({ url: `/api/documents/${doc}/markups`, headers: h })).json() as any[]
    expect((await put(idOf(1), 10)).statusCode).toBe(200); const p2 = await put(idOf(2), 20); expect(p2.statusCode, p2.body).toBe(200)
    await app.inject({ method: 'PUT', url: `/api/documents/${doc}/scales/1`, headers: h, payload: { points_per_foot: 12, label: 'Old' } })
    // second revision freezes revision 1 (two markups); then edit the live set
    expect((await send(`/api/documents/${doc}/revisions`, admin, mp(1, pdfTwo))).statusCode).toBe(200)
    await put(idOf(1), 99); await put(idOf(3), 30)
    await app.inject({ method: 'DELETE', url: `/api/documents/${doc}/markups/${idOf(2)}`, headers: h })
    await app.inject({ method: 'PUT', url: `/api/documents/${doc}/scales/1`, headers: h, payload: { points_per_foot: 24, label: 'New' } })
    const revs = (await app.inject({ url: `/api/documents/${doc}/revisions`, headers: h })).json()
    const rev1 = revs.find((r: any) => r.revision === 1)

    const url = `/api/documents/${doc}/revisions/${rev1.id}/make-current`
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${viewer}` } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/documents/${doc}/revisions/${revs[0].id}/make-current`, headers: h })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/documents/${doc}/revisions/99999999-9999-4999-8999-999999999999/make-current`, headers: h })).statusCode).toBe(404)
    const res = await app.inject({ method: 'POST', url, headers: h })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ revision: 4, label: 'Rev 4 (restored from Rev 1)', kind: 'restore', removed_markups: 1, restored_markups: 2 })

    const list = (await app.inject({ url: `/api/documents/${doc}/revisions`, headers: h })).json()
    expect(list.map((r: any) => [r.revision, r.label])).toEqual([[4, 'Rev 4 (restored from Rev 1)'], [3, 'Before restoring Rev 1'], [2, ''], [1, '']])
    expect(list[1].has_snapshot).toBe(true)
    expect(list[0].has_snapshot).toBe(false)
    const now = Object.fromEntries((await live()).map(m => [m.id, m.geometry.x]))
    expect(now).toEqual({ [idOf(1)]: 10, [idOf(2)]: 20 })
    const before = (await app.inject({ url: `/api/documents/${doc}/revisions/${list[1].id}`, headers: h })).json()
    expect(Object.fromEntries(before.markups.map((m: any) => [m.id, m.geometry.x]))).toEqual({ [idOf(1)]: 99, [idOf(3)]: 30 })
    expect(before.scales[0]).toMatchObject({ label: 'New' })
    expect((await app.inject({ url: `/api/documents/${doc}/scales`, headers: h })).json()).toMatchObject([{ page: 1, points_per_foot: 12, label: 'Old' }])
    const file = await app.inject({ url: `/api/documents/${doc}/file?token=${admin}` })
    expect(file.rawPayload.equals(pdfOne)).toBe(true)
  })

  it('reorders device types of a set (admin only) and validates ids', async () => {
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@x.com', password: 'password1' } })).json().token
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const h = { authorization: `Bearer ${admin}` }
    const cat = (await app.inject({ url: '/api/catalog', headers: h })).json()
    const fire = (await app.inject({ url: '/api/symbol-sets', headers: h })).json().find((s: any) => s.tag_prefix === 'FA')
    const types = cat.device_types.filter((t: any) => t.symbol_set_id === fire.id).sort((a: any, b: any) => a.sort - b.sort)
    expect(types.length).toBeGreaterThan(2)
    const wanted = [...types].reverse().map((t: any) => t.id)
    const url = `/api/symbol-sets/${fire.id}/device-types/order`
    const sorted = async () => (await app.inject({ url: '/api/catalog', headers: h })).json().device_types
      .filter((t: any) => t.symbol_set_id === fire.id).sort((a: any, b: any) => a.sort - b.sort).map((t: any) => t.id)
    expect((await app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${viewer}` }, payload: { ids: wanted } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url, headers: h, payload: { ids: ['x'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url, headers: h, payload: { ids: ['99999999-9999-4999-8999-999999999999'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url, headers: h, payload: { ids: wanted } })).statusCode).toBe(200)
    expect(await sorted()).toEqual(wanted)
    await app.inject({ method: 'PUT', url, headers: h, payload: { ids: [wanted[wanted.length - 1]] } })
    const partial = await sorted()
    expect(partial[0]).toBe(wanted[wanted.length - 1])
    expect(partial).toHaveLength(wanted.length)
  })
})
