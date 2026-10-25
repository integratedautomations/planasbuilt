// A database created by an older build keeps its old tables (CREATE TABLE IF NOT EXISTS adds no columns): migrate must add what is missing.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'

let db: Awaited<ReturnType<typeof openDb>>
let app: Awaited<ReturnType<typeof buildApp>>
const tok: Record<string, string> = {}
const call = (method: any, url: string, who: string, payload?: any) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok[who]}` } })

beforeAll(async () => {
  db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-upg-')) })
  tok.root = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'r@x.com', name: 'Root', password: 'password1', setupCode: 'test-setup-code' } })).json().token
})
afterAll(async () => { await app.close() })

describe('upgrading an older database', () => {
  it('re-adds columns missing from company_invitations and the invitation flow works', async () => {
    await db.query('ALTER TABLE company_invitations DROP COLUMN can_create_projects')
    await db.query('ALTER TABLE company_invitations DROP COLUMN projects')
    await db.query('ALTER TABLE company_members DROP COLUMN can_create_projects')
    await migrate(db)
    const cols = (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'company_invitations'")).map(c => c.column_name)
    expect(cols).toEqual(expect.arrayContaining(['can_create_projects', 'projects', 'invited_by', 'created_at']))
    await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${tok.root}` }, payload: { email: 'u@x.com', name: 'U', password: 'password1' } })
    expect((await db.query('SELECT 1 FROM company_members WHERE can_create_projects IS NOT NULL LIMIT 1')).length).toBe(1)
  })

  it('a company guest never sees costs on a project', async () => {
    const pid = (await call('POST', '/api/projects', 'root', { name: 'P' })).json().id
    await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${tok.root}` }, payload: { email: 'g@x.com', name: 'G', password: 'password1' } })
    tok.g = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'g@x.com', password: 'password1' } })).json().token
    expect((await call('PUT', `/api/projects/${pid}/members`, 'root', { email: 'g@x.com', role: 'viewer' })).statusCode).toBe(200)
    expect((await call('GET', `/api/projects/${pid}`, 'g')).json().can_see_costs).toBe(true)
    await db.query("UPDATE company_members SET role = 'guest' WHERE user_id = (SELECT id FROM users WHERE email = 'g@x.com')")
    expect((await call('GET', `/api/projects/${pid}`, 'g')).json().can_see_costs).toBe(false)
  })
})
