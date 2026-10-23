import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import type { Db } from './db.js'
import { buildApp } from './app.js'
import { STD_CABLE_TYPES, installLibrary, planLibrary, previewLibrary } from './standardLibrary.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let admin = '', bob = '', projectId = ''
const H = (t: string) => ({ authorization: `Bearer ${t}` })

beforeAll(async () => {
  db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-cable-')) })
  admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann', password: 'password1', setupCode: 'test-setup-code' } })).json().token
  await app.inject({ method: 'POST', url: '/api/users', headers: H(admin), payload: { email: 'b@x.com', name: 'Bob', password: 'password1' } })
  bob = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'b@x.com', password: 'password1' } })).json().token
  projectId = (await app.inject({ method: 'POST', url: '/api/projects', headers: H(admin), payload: { name: 'P' } })).json().id
})

describe('cable types', () => {
  it('are managed by admins and listed in the catalog', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/cable-types', headers: H(bob), payload: { name: 'Cat6', color: '#1971c2' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/cable-types', headers: H(admin), payload: { name: '', color: '#1971c2' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/cable-types', headers: H(admin), payload: { name: 'X', color: 'red' } })).statusCode).toBe(400)
    const made = (await app.inject({ method: 'POST', url: '/api/cable-types', headers: H(admin), payload: { name: 'Cat5e', color: '#1971c2' } })).json()
    expect(made).toMatchObject({ name: 'Cat5e', color: '#1971c2' })
    const upd = (await app.inject({ method: 'PUT', url: `/api/cable-types/${made.id}`, headers: H(admin), payload: { name: 'Cat5e UTP', color: '#e03131' } })).json()
    expect(upd).toMatchObject({ name: 'Cat5e UTP', color: '#e03131' })
    let cat = (await app.inject({ method: 'GET', url: '/api/catalog', headers: H(bob) })).json()
    expect(cat.cable_types.find((c: any) => c.name === 'Cat5e UTP')).toMatchObject({ archived: false })
    expect((await app.inject({ method: 'DELETE', url: `/api/cable-types/${made.id}`, headers: H(admin) })).json()).toEqual({ ok: true })
    cat = (await app.inject({ method: 'GET', url: '/api/catalog', headers: H(bob) })).json()
    expect(cat.cable_types.find((c: any) => c.name === 'Cat5e UTP')).toMatchObject({ archived: true }) // kept so drawn cables keep their name and colour
  })

  it('the standard library adds the default list once and never brings back a removed one', async () => {
    const plan = planLibrary([], [], ['cat6', 'Fiber'])
    expect(plan.cableTypesToAdd).toEqual(STD_CABLE_TYPES.map(c => c.name).filter(n => n !== 'Cat6' && n !== 'Fiber'))
    const company = (await db.query<{ id: string }>('SELECT id FROM companies ORDER BY created_at LIMIT 1'))[0].id
    expect((await previewLibrary(db, company)).cableTypesAdded).toBe(STD_CABLE_TYPES.length)
    const run = await installLibrary(db, company)
    expect(run.cableTypesAdded).toBe(STD_CABLE_TYPES.length)
    const names = (await db.query<{ name: string }>('SELECT name FROM cable_types WHERE NOT archived')).map(r => r.name)
    for (const c of STD_CABLE_TYPES) expect(names).toContain(c.name)
    expect((await installLibrary(db, company)).cableTypesAdded).toBe(0)
    await db.query("UPDATE cable_types SET archived = true WHERE name = 'RG6'")
    expect((await installLibrary(db, company)).cableTypesAdded).toBe(0)
    expect((await db.query("SELECT 1 FROM cable_types WHERE name = 'RG6' AND NOT archived")).length).toBe(0)
  })
})

describe('project cable defaults', () => {
  it('start at 10 percent slack and no drop, and can be changed', async () => {
    const p = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: H(admin) })).json()
    expect(p).toMatchObject({ cable_slack_pct: 10, cable_drop_ft: 0 })
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, headers: H(admin), payload: { cable_slack_pct: 15, cable_drop_ft: 8 } })
    expect(res.json()).toMatchObject({ cable_slack_pct: 15, cable_drop_ft: 8 })
    const one = await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, headers: H(admin), payload: { cable_drop_ft: 3 } })
    expect(one.json()).toMatchObject({ cable_slack_pct: 15, cable_drop_ft: 3 })
  })
  it('rejects nonsense and people who cannot edit plans', async () => {
    for (const payload of [{ cable_slack_pct: -1 }, { cable_drop_ft: 'a' }, { cable_slack_pct: 5000 }])
      expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, headers: H(admin), payload })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, headers: H(bob), payload: { cable_drop_ft: 1 } })).statusCode).toBeGreaterThanOrEqual(403)
  })
})
