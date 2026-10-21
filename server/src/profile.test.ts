import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'

let app: Awaited<ReturnType<typeof buildApp>>
let admin = '', bob = '', adminId = '', projectId = ''
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d49484452', 'hex'), Buffer.alloc(16)])
const upload = (token: string, type: string, body: Buffer) => app.inject({
  method: 'POST', url: '/api/me/avatar', headers: { ...H(token), 'content-type': 'multipart/form-data; boundary=AA' },
  payload: Buffer.concat([Buffer.from(`--AA\r\nContent-Disposition: form-data; name="photo"; filename="a"\r\nContent-Type: ${type}\r\n\r\n`), body, Buffer.from('\r\n--AA--\r\n')]),
})

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-prof-')) })
  const setup = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann Admin', password: 'password1', setupCode: 'test-setup-code' } })).json()
  admin = setup.token; adminId = setup.user.id
  await app.inject({ method: 'POST', url: '/api/users', headers: H(admin), payload: { email: 'b@x.com', name: 'Bob', password: 'password1' } })
  bob = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'b@x.com', password: 'password1' } })).json().token
  projectId = (await app.inject({ method: 'POST', url: '/api/projects', headers: H(admin), payload: { name: 'P' } })).json().id
})

describe('profile picture', () => {
  it('has none at first, then stores, serves and clears one', async () => {
    expect((await app.inject({ url: '/api/me', headers: H(admin) })).json().avatar).toBeNull()
    expect((await upload(admin, 'text/html', PNG)).statusCode).toBe(400)
    const ok = await upload(admin, 'image/png', PNG)
    expect(ok.statusCode).toBe(200)
    const v = ok.json().avatar
    expect(v).toBeGreaterThan(0)
    expect((await app.inject({ url: '/api/me', headers: H(admin) })).json().avatar).toBe(v)
    const got = await app.inject({ url: `/api/users/${adminId}/avatar`, headers: H(bob) })
    expect(got.statusCode).toBe(200)
    expect(got.headers['content-type']).toBe('image/png')
    expect((await app.inject({ url: `/api/users/${adminId}/avatar` })).statusCode).toBe(401)
    const del = await app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: H(admin) })
    expect(del.json().avatar).toBeNull()
    expect((await app.inject({ url: `/api/users/${adminId}/avatar`, headers: H(bob) })).statusCode).toBe(404)
  })
})

describe('completing projects', () => {
  const patch = (token: string, status: unknown) => app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, headers: H(token), payload: { status } })
  it('lists new projects as open', async () => {
    const list = (await app.inject({ url: '/api/projects', headers: H(admin) })).json()
    expect(list[0]).toMatchObject({ id: projectId, status: 'open', completed_at: null })
  })
  it('lets an editor complete and reopen, but not a viewer or a stranger', async () => {
    expect((await patch(bob, 'completed')).statusCode).toBe(403) // not a member
    await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/members`, headers: H(admin), payload: { email: 'b@x.com', role: 'viewer' } })
    expect((await patch(bob, 'completed')).statusCode).toBe(403)
    await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/members`, headers: H(admin), payload: { email: 'b@x.com', role: 'editor' } })
    const done = await patch(bob, 'completed')
    expect(done.statusCode).toBe(200)
    expect(done.json()).toMatchObject({ status: 'completed' })
    expect(done.json().completed_at).toBeTruthy()
    // still fully openable
    expect((await app.inject({ url: `/api/projects/${projectId}`, headers: H(bob) })).json().status).toBe('completed')
    expect((await app.inject({ url: `/api/projects/${projectId}/documents`, headers: H(bob) })).statusCode).toBe(200)
    const reopened = await patch(admin, 'open')
    expect(reopened.json()).toMatchObject({ status: 'open', completed_at: null })
  })
  it('rejects an unknown status', async () => {
    expect((await patch(admin, 'archived')).statusCode).toBe(400)
  })
})
