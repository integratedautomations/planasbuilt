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
})
