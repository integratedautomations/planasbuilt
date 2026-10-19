import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { openDb, migrate } from './db.js'
import { buildApp } from './app.js'

let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-')) })
})

const pdf = Buffer.from('%PDF-1.4\n%%EOF\n')
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
      payload: { email: 'Boss@x.com', name: 'Boss', password: 'password1' } })
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

  it('blocks viewers from editing markups', async () => {
    const viewer = (await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'tech@x.com', password: 'password1' } })).json().token
    const res = await app.inject({ method: 'PUT', url: `/api/documents/${docId}/markups/22222222-2222-4222-8222-222222222222`,
      headers: { authorization: `Bearer ${viewer}` }, payload: { page: 1, type: 'line', geometry: {} } })
    expect(res.statusCode).toBe(403)
  })
})
