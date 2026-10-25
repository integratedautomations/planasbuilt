import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'

let app: Awaited<ReturnType<typeof buildApp>>
let admin = ''
const H = (t: string) => ({ authorization: `Bearer ${t}` })

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-legend-')) })
  admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann', password: 'password1', setupCode: 'test-setup-code' } })).json().token
})

describe('legend presets', () => {
  it('round-trips create, list, update and delete, and rejects bad settings', async () => {
    const settings = { scope: 'document', sort: 'count-desc', columns: 'icon,name,count', groupBySet: '1' }
    expect((await app.inject({ method: 'POST', url: '/api/legend-presets', headers: H(admin), payload: { name: '', settings } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/legend-presets', headers: H(admin), payload: { name: 'X', settings: { a: 5 } } })).statusCode).toBe(400)
    const made = (await app.inject({ method: 'POST', url: '/api/legend-presets', headers: H(admin), payload: { name: 'By count', settings } })).json()
    expect(made).toMatchObject({ name: 'By count', set_id: null, settings })
    let list = (await app.inject({ method: 'GET', url: '/api/legend-presets', headers: H(admin) })).json()
    expect(list.map((p: any) => p.name)).toEqual(['By count'])
    const upd = (await app.inject({ method: 'PUT', url: `/api/legend-presets/${made.id}`, headers: H(admin), payload: { name: 'Renamed', settings: { ...settings, sort: 'name' } } })).json()
    expect(upd).toMatchObject({ name: 'Renamed', settings: { sort: 'name' } })
    expect((await app.inject({ method: 'DELETE', url: `/api/legend-presets/${made.id}`, headers: H(admin) })).json()).toEqual({ ok: true })
    list = (await app.inject({ method: 'GET', url: '/api/legend-presets', headers: H(admin) })).json()
    expect(list).toEqual([])
    expect((await app.inject({ method: 'DELETE', url: `/api/legend-presets/${made.id}`, headers: H(admin) })).statusCode).toBe(404)
  })
})
