// Archiving, restoring and permanently deleting projects, and deleting deactivated people.
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Awaited<ReturnType<typeof openDb>>
let filesDir = ''
let root = '', member = '', c1 = ''
const api = (method: string, url: string, token: string, payload?: any) =>
  app.inject({ method: method as any, url, payload, headers: { authorization: `Bearer ${token}`, 'x-company-id': c1 } })
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1' } })).json().token as string
const mp = (name: string, file: Buffer) => Buffer.concat([
  Buffer.from(`--SB\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
  Buffer.from(`--SB\r\nContent-Disposition: form-data; name="file"; filename="${name}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), file, Buffer.from('\r\n--SB--\r\n')])
const upload = (project: string, name: string, pdf: Buffer) =>
  app.inject({ method: 'POST', url: `/api/projects/${project}/documents`, payload: mp(name, pdf),
    headers: { authorization: `Bearer ${root}`, 'x-company-id': c1, 'content-type': 'multipart/form-data; boundary=SB' } })
const fileExists = (key: string) => existsSync(path.join(filesDir, ...key.split('/')))
const keyOf = async (sql: string, p: unknown[] = []) => (await db.query<{ k: string }>(sql, p))[0]?.k
const newProject = async (name: string) => (await api('POST', '/api/projects', root, { name })).json().id as string
const listed = async (token: string, extra = '') => (await api('GET', `/api/projects${extra}`, token)).json().map((p: any) => p.id) as string[]

beforeAll(async () => {
  db = await openDb(undefined, null)
  await migrate(db)
  filesDir = mkdtempSync(path.join(tmpdir(), 'pm-life-'))
  app = await buildApp({ db, jwtSecret: 'test', filesDir })
  root = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'root@x.com', name: 'Root', password: 'password1', setupCode: 'test-setup-code' } })).json().token
  c1 = (await api('GET', '/api/companies', root)).json()[0].id
  expect((await api('POST', '/api/users', root, { email: 'mem@x.com', name: 'Mem', password: 'password1' })).statusCode).toBe(200)
  member = await login('mem@x.com')
})
afterAll(async () => { await app.close() })

describe('archive and restore', () => {
  it('hides an archived project, blocks writes with 423 and restores it', async () => {
    const p = await newProject('Archive me')
    await api('PUT', `/api/projects/${p}/members`, root, { email: 'mem@x.com', role: 'admin' })
    expect((await upload(p, 'Level 1', await makePdf(1, 'a1'))).statusCode).toBe(200)
    expect(await listed(root)).toContain(p)

    const r = await api('PATCH', `/api/projects/${p}`, root, { archived: true })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ archived: true })
    expect(await listed(root)).not.toContain(p)
    expect(await listed(member)).not.toContain(p)
    const all = (await api('GET', '/api/projects?include_archived=1', root)).json()
    expect(all.find((x: any) => x.id === p)).toMatchObject({ archived: true })
    expect(await listed(member, '?include_archived=1')).not.toContain(p) // only admins may ask for them

    // still readable, never writable (not even by the admin)
    expect((await api('GET', `/api/projects/${p}`, root)).statusCode).toBe(200)
    expect((await api('GET', `/api/projects/${p}/documents`, root)).statusCode).toBe(200)
    for (const who of [root, member]) {
      const w = await api('POST', `/api/projects/${p}/layers`, who, { name: 'L' })
      expect(w.statusCode).toBe(423)
      expect(w.json().error).toMatch(/archived/i)
    }
    expect((await api('PATCH', `/api/projects/${p}`, root, { name: 'New name' })).statusCode).toBe(423)

    const back = await api('PATCH', `/api/projects/${p}`, root, { archived: false })
    expect(back.json()).toMatchObject({ archived: false, archived_at: null })
    expect(await listed(root)).toContain(p)
    expect((await api('POST', `/api/projects/${p}/layers`, root, { name: 'L' })).statusCode).toBe(200)
  })

  it('is for company admins only', async () => {
    const p = await newProject('Members cannot archive')
    await api('PUT', `/api/projects/${p}/members`, root, { email: 'mem@x.com', role: 'admin' })
    expect((await api('PATCH', `/api/projects/${p}`, member, { archived: true })).statusCode).toBe(403)
    expect((await api('PATCH', `/api/projects/${p}`, root, { archived: 'yes' })).statusCode).toBe(400)
    expect((await api('GET', '/api/projects', root)).json().find((x: any) => x.id === p).archived).toBe(false)
  })
})

describe('delete permanently', () => {
  it('needs the exact name and is for company admins only', async () => {
    const p = await newProject('Keep Me')
    await api('PUT', `/api/projects/${p}/members`, root, { email: 'mem@x.com', role: 'admin' })
    expect((await api('DELETE', `/api/projects/${p}`, member, { name: 'Keep Me' })).statusCode).toBe(403)
    expect((await api('DELETE', `/api/projects/${p}`, root, { name: 'keep me' })).statusCode).toBe(400)
    expect((await api('DELETE', `/api/projects/${p}`, root)).statusCode).toBe(400)
    expect((await api('DELETE', `/api/projects/${p}`, root, { name: '  Keep Me ' })).statusCode).toBe(200) // trimmed
    expect((await api('GET', `/api/projects/${p}`, root)).statusCode).toBe(404)
  })

  it('removes the rows, trashes the files, and keeps files another project still uses', async () => {
    const p = await newProject('Doomed')
    const other = await newProject('Survivor')
    const d = (await upload(p, 'Plan A', await makePdf(1, 'doomed'))).json().id as string
    const shared = (await upload(p, 'Plan B', await makePdf(1, 'shared-bytes'))).json().id as string
    const od = (await upload(other, 'Plan C', await makePdf(1, 'other'))).json().id as string
    const keyA = (await keyOf('SELECT file_key AS k FROM document_revisions WHERE document_id = $1', [d]))!
    const keyB = (await keyOf('SELECT file_key AS k FROM document_revisions WHERE document_id = $1', [shared]))!
    const keyC = (await keyOf('SELECT file_key AS k FROM document_revisions WHERE document_id = $1', [od]))!
    // make a file of the doomed project also referenced by the survivor
    await db.query('INSERT INTO document_revisions (document_id, revision, file_key, page_count) VALUES ($1, 2, $2, 1)', [od, keyB])
    await api('POST', `/api/projects/${p}/layers`, root, { name: 'Layer' })
    const markup = '33333333-3333-4333-8333-333333333333'
    expect((await api('PUT', `/api/documents/${d}/markups/${markup}`, root, { page: 1, type: 'note', geometry: { x: 0, y: 0, width: 5, height: 5, rotation: 0 } })).statusCode).toBe(200)
    expect(fileExists(keyA)).toBe(true)

    const r = await api('DELETE', `/api/projects/${p}`, root, { name: 'Doomed' })
    expect(r.statusCode, r.body).toBe(200)
    const left = async (sql: string) => (await db.query<{ n: number }>(sql, [p]))[0].n
    expect(await left('SELECT count(*)::int AS n FROM projects WHERE id = $1')).toBe(0)
    expect(await left('SELECT count(*)::int AS n FROM documents WHERE project_id = $1')).toBe(0)
    expect(await left('SELECT count(*)::int AS n FROM layers WHERE project_id = $1')).toBe(0)
    expect(await left('SELECT count(*)::int AS n FROM project_members WHERE project_id = $1')).toBe(0)
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM markups WHERE id = $1', [markup]))[0].n).toBe(0)

    // the file is in _trash, not hard-deleted; the shared one and the other project's own stay
    expect(fileExists(keyA)).toBe(false)
    const stamps = readdirSync(path.join(filesDir, '_trash'))
    expect(stamps.some(st => existsSync(path.join(filesDir, '_trash', st, ...keyA.split('/'))))).toBe(true)
    expect(fileExists(keyB)).toBe(true)
    expect(fileExists(keyC)).toBe(true)
    expect(stamps.some(st => existsSync(path.join(filesDir, '_trash', st, ...keyB.split('/'))))).toBe(false)
    expect(await listed(root)).toContain(other)
  })
})

describe('delete a deactivated person', () => {
  const add = async (email: string) => (await api('POST', '/api/users', root, { email, name: email.split('@')[0], password: 'password1' })).json().id as string

  it('refuses active people, yourself and non-admins; keeps what they wrote', async () => {
    const id = await add('gone@x.com')
    const proj = await newProject('Authored')
    await api('PUT', `/api/projects/${proj}/members`, root, { email: 'gone@x.com', role: 'editor' })
    const doc = (await upload(proj, 'Plan', await makePdf(1, 'authored'))).json().id as string
    const gone = await login('gone@x.com')
    const markup = '44444444-4444-4444-8444-444444444444'
    expect((await api('PUT', `/api/documents/${doc}/markups/${markup}`, gone, { page: 1, type: 'note', geometry: { x: 0, y: 0, width: 5, height: 5, rotation: 0 } })).statusCode).toBe(200)

    expect((await api('DELETE', `/api/users/${id}`, root)).statusCode).toBe(400) // still active
    const rootId = (await api('GET', '/api/users', root)).json().find((u: any) => u.email === 'root@x.com').id
    expect((await api('DELETE', `/api/users/${rootId}`, root)).statusCode).toBe(400) // self
    expect((await api('DELETE', `/api/users/${id}`, member)).statusCode).toBe(403)

    expect((await api('PATCH', `/api/users/${id}`, root, { status: 'deactivated' })).statusCode).toBe(200)
    const r = await api('DELETE', `/api/users/${id}`, root)
    expect(r.statusCode, r.body).toBe(200)
    expect((await db.query('SELECT 1 FROM users WHERE id = $1', [id])).length).toBe(0)
    expect((await db.query('SELECT 1 FROM company_members WHERE user_id = $1', [id])).length).toBe(0)
    expect((await db.query('SELECT 1 FROM project_members WHERE user_id = $1', [id])).length).toBe(0)
    const [m] = await db.query<any>('SELECT created_by, updated_by FROM markups WHERE id = $1', [markup])
    expect(m).toMatchObject({ created_by: null, updated_by: null }) // the markup stays, with no author
    expect((await api('GET', `/api/projects/${proj}`, root)).statusCode).toBe(200)
  })

  it('only a platform admin deletes a person who is also in another company', async () => {
    const id = await add('shared@x.com')
    const c2 = (await api('POST', '/api/companies', root, { name: 'Other Co' })).json().id as string
    await db.query("INSERT INTO company_members (company_id, user_id, role) VALUES ($1,$2,'member')", [c2, id])
    await db.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [id])
    const adminId = await add('coadmin@x.com')
    await db.query("UPDATE company_members SET role = 'admin' WHERE user_id = $1", [adminId])
    const coAdmin = await login('coadmin@x.com')
    const refused = await api('DELETE', `/api/users/${id}`, coAdmin)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).toMatch(/other companies/)
    expect((await api('DELETE', `/api/users/${id}`, root)).statusCode).toBe(200)
  })
})
