import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'
import { setTransportFactory } from './mail.js'
import { clientIp, normalizePublicUrl } from './net.js'

type App = Awaited<ReturnType<typeof buildApp>>
const SETUP = { setupCode: 'test-setup-code' }
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

async function freshApp(opts: Partial<Parameters<typeof buildApp>[0]> = {}, first = true) {
  const db = await openDb(undefined, null)
  await migrate(db)
  const app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-hard-')), ...opts } as any)
  let admin = ''
  if (first) admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'boss@x.com', name: 'Boss', password: 'password1', ...SETUP } })).json().token
  const api = (method: string, url: string, token: string, payload?: any, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload, headers: { ...(token ? bearer(token) : {}), ...headers } })
  const login = async (email: string, password = 'password1') =>
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).json().token as string
  const mkUser = async (email: string, extra: object = {}) => {
    const r = await api('POST', '/api/users', admin, { email, name: email.split('@')[0], password: 'password1', ...extra })
    expect(r.statusCode).toBe(200)
    return r.json().id as string
  }
  return { app, db, admin, api, login, mkUser }
}

const apps: App[] = []
afterAll(async () => { for (const a of apps) await a.close() })
const track = async (...a: Parameters<typeof freshApp>) => { const r = await freshApp(...a); apps.push(r.app); return r }

describe('invite links come from PUBLIC_URL, never from the Origin header', () => {
  it('uses PUBLIC_URL for returned, resent, reset and emailed links and ignores Origin', async () => {
    const sent: any[] = []
    setTransportFactory(() => ({ sendMail: async o => { sent.push(o) } }))
    const { api, admin, mkUser } = await track({ publicUrl: 'https://pab.example.com/' })
    const evil = { origin: 'https://evil.example', host: 'evil.example' }
    const r = await api('POST', '/api/invites', admin, { email: 'new@x.com', role: 'user' }, evil)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().link).toMatch(/^https:\/\/pab\.example\.com\/invite\/[A-Za-z0-9_-]{43}$/)
    const again = await api('POST', `/api/users/${r.json().user_id}/invite`, admin, undefined, evil)
    expect(again.json().link).toMatch(/^https:\/\/pab\.example\.com\/invite\//)
    const uid = await mkUser('member@x.com')
    const reset = await api('POST', `/api/users/${uid}/reset`, admin, undefined, evil)
    expect(reset.json().link).toMatch(/^https:\/\/pab\.example\.com\/reset\//)
    // the emailed copy is built from the same base
    await api('PUT', '/api/settings', admin, { smtp: { host: 'smtp.example.com', port: 587, from: 'a@x.com' } })
    const mailed = await api('POST', '/api/invites', admin, { email: 'mailed@x.com', role: 'user' }, evil)
    expect(mailed.json().emailed).toBe(true)
    expect(sent.at(-1).text).toContain('https://pab.example.com/invite/')
    expect(sent.at(-1).text).not.toContain('evil.example')
  })

  it('without PUBLIC_URL falls back to the request Host, still never Origin', async () => {
    const { app, admin } = await track({})
    const r = await app.inject({ method: 'POST', url: '/api/invites', payload: { email: 'h@x.com', role: 'user' },
      headers: { ...bearer(admin), origin: 'https://evil.example', host: 'pab.lan:8080' } })
    expect(r.json().link).toMatch(/^http:\/\/pab\.lan:8080\/invite\//)
    const bad = await app.inject({ method: 'POST', url: '/api/invites', payload: { email: 'h2@x.com', role: 'user' },
      headers: { ...bearer(admin), host: 'evil.example/<script>' } })
    expect(bad.json().link).not.toContain('<script>')
  })

  it('normalizes PUBLIC_URL and rejects junk', () => {
    expect(normalizePublicUrl('https://pab.example.com/some/path/')).toBe('https://pab.example.com')
    expect(normalizePublicUrl('  ')).toBeNull()
    expect(normalizePublicUrl(undefined)).toBeNull()
    expect(() => normalizePublicUrl('javascript:alert(1)')).toThrow()
    expect(() => normalizePublicUrl('not a url')).toThrow()
  })

  it('rate-limits invite creation per user', async () => {
    const { api, admin, mkUser, login } = await track({ inviteRateLimitMax: 2 })
    await mkUser('other@x.com', { isAdmin: true })
    const other = await login('other@x.com')
    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await api('POST', '/api/invites', admin, { email: `i${i}@x.com`, role: 'user' })).statusCode)
    expect(codes).toEqual([200, 200, 429, 429])
    // another user has their own allowance
    expect((await api('POST', '/api/invites', other, { email: 'ok@x.com', role: 'user' })).statusCode).toBe(200)
  })
})

describe('who can create projects', () => {
  it('is limited to app admins and users granted can_create_projects', async () => {
    const { api, admin, mkUser, login } = await track({})
    const id = await mkUser('u@x.com')
    const u = await login('u@x.com')
    const denied = await api('POST', '/api/projects', u, { name: 'Mine' })
    expect(denied.statusCode).toBe(403)
    expect((await api('GET', '/api/me', u)).json().can_create_projects).toBe(false)
    expect((await api('GET', '/api/me', admin)).json().can_create_projects).toBe(true)
    // only an admin can grant it
    expect((await api('PATCH', `/api/users/${id}`, u, { can_create_projects: true })).statusCode).toBe(403)
    const granted = await api('PATCH', `/api/users/${id}`, admin, { can_create_projects: true })
    expect(granted.json().can_create_projects).toBe(true)
    expect((await api('GET', '/api/me', u)).json().can_create_projects).toBe(true)
    const ok = await api('POST', '/api/projects', u, { name: 'Mine' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().role).toBe('admin')
    expect((await api('GET', '/api/users', admin)).json().find((x: any) => x.id === id).can_create_projects).toBe(true)
    // revoking works too
    await api('PATCH', `/api/users/${id}`, admin, { can_create_projects: false })
    expect((await api('POST', '/api/projects', u, { name: 'Again' })).statusCode).toBe(403)
    // admins can always create
    expect((await api('POST', '/api/projects', admin, { name: 'Boss project' })).statusCode).toBe(200)
  })

  it('lets only app admins write Revu mappings, even editors and project admins', async () => {
    const { api, admin, mkUser, login } = await track({})
    await mkUser('pa@x.com', { canCreateProjects: true })
    const pa = await login('pa@x.com')
    const pid = (await api('POST', '/api/projects', pa, { name: 'PA' })).json().id // project admin + editor somewhere
    expect(pid).toBeTruthy()
    const body = { mappings: [{ signature: 'x', action: 'plain' }] }
    expect((await api('PUT', '/api/revu-mappings', pa, body)).statusCode).toBe(403)
    expect((await api('GET', '/api/revu-mappings', pa)).statusCode).toBe(200)
    expect((await api('PUT', '/api/revu-mappings', admin, body)).statusCode).toBe(200)
  })

  it('saves many Revu mappings in bulk and validates references', async () => {
    const { api, admin } = await track({})
    const sets = (await api('GET', '/api/symbol-sets', admin)).json()
    const set = sets.find((s: any) => s.name === 'Network') ?? sets[0]
    const cat = (await api('GET', '/api/catalog', admin)).json()
    const type = cat.device_types.find((t: any) => t.symbol_set_id === set.id)
    const other = cat.device_types.find((t: any) => t.symbol_set_id !== set.id)
    const product = cat.products.find((p: any) => p.device_type_id === type.id)
    const mappings = Array.from({ length: 300 }, (_, i) => ({ signature: `sig-${i}`, action: 'device', symbol_set_id: set.id.toUpperCase(), device_type_id: type.id, product_id: product?.id ?? null }))
    mappings.push({ signature: 'sig-0', action: 'skip' } as any) // repeated signature: the last one wins
    const r = await api('PUT', '/api/revu-mappings', admin, { mappings })
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json()
    expect(rows).toHaveLength(300)
    expect(rows.find((x: any) => x.signature === 'sig-0')).toMatchObject({ action: 'skip', symbol_set_id: null })
    expect(rows.find((x: any) => x.signature === 'sig-7')).toMatchObject({ action: 'device', symbol_set_id: set.id, device_type_id: type.id })
    const wrongType = await api('PUT', '/api/revu-mappings', admin, { mappings: [{ signature: 'y', action: 'device', symbol_set_id: set.id, device_type_id: other.id }] })
    expect(wrongType.json().error).toBe('Unknown device type')
    const noProduct = await api('PUT', '/api/revu-mappings', admin, { mappings: [{ signature: 'y', action: 'device', symbol_set_id: set.id, product_id: '77777777-7777-4777-8777-777777777777' }] })
    expect(noProduct.json().error).toBe('Unknown product')
    expect((await api('GET', '/api/revu-mappings', admin)).json()).toHaveLength(300) // failed saves wrote nothing
  })
})

describe('rate limits use the real client IP', () => {
  const login = (app: App, remote: string, headers: Record<string, string> = {}, email = 'x@x.com') =>
    app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: remote, headers, payload: { email, password: 'wrong' } })

  it('ignores a client-supplied X-Forwarded-For from the open internet', async () => {
    const { app } = await track({ rateLimitMax: 3 }, false)
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await login(app, '203.0.113.9', { 'x-forwarded-for': `9.9.9.${i}`, 'cf-connecting-ip': `8.8.8.${i}` }, `e${i}@x.com`)).statusCode)
    expect(codes).toEqual([401, 401, 401, 429, 429])
  })

  it('uses CF-Connecting-IP only when the peer is the private tunnel network', async () => {
    const { app } = await track({ rateLimitMax: 2 }, false)
    const run = async (cf: string) => {
      const out: number[] = []
      for (let i = 0; i < 3; i++) out.push((await login(app, '172.18.0.5', { 'cf-connecting-ip': cf, 'x-forwarded-for': `1.1.1.${i}` }, `${cf}-${i}@x.com`)).statusCode)
      return out
    }
    expect(await run('198.51.100.1')).toEqual([401, 401, 429])
    expect(await run('198.51.100.2')).toEqual([401, 401, 429]) // a different visitor has their own budget
  })

  it('computes clientIp from the socket unless a private peer vouches with CF-Connecting-IP', () => {
    const req = (peer: string, h: Record<string, string> = {}) => ({ socket: { remoteAddress: peer }, headers: h, ip: 'fallback' }) as any
    expect(clientIp(req('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4' }))).toBe('203.0.113.9')
    expect(clientIp(req('172.18.0.5', { 'cf-connecting-ip': '1.2.3.4' }))).toBe('1.2.3.4')
    expect(clientIp(req('::ffff:10.0.0.2', { 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1')
    expect(clientIp(req('172.18.0.5', { 'cf-connecting-ip': 'garbage' }))).toBe('172.18.0.5')
    expect(clientIp(req('::ffff:203.0.113.9'))).toBe('203.0.113.9')
  })

  it('ignores spoofed X-Forwarded-For when deriving req.ip', async () => {
    const { app } = await track({}, false)
    const seen: string[] = []
    app.addHook('onRequest', async r => { seen.push(r.ip) })
    app.get('/api/_ip', async r => ({ ip: r.ip }))
    await app.inject({ url: '/api/_ip', remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '1.2.3.4' } })
    expect(seen[0]).toBe('203.0.113.9')
  })
})

describe('per-account login lockout', () => {
  afterEach(() => { vi.useRealTimers() })

  it('backs off for longer after repeated failures and unlocks on the right password', async () => {
    const { app, mkUser } = await track({ rateLimitMax: 3 })
    await mkUser('victim@x.com')
    vi.useFakeTimers({ toFake: ['Date'] })
    let ip = 0
    const go = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.1.0.${++ip}`, payload: { email: 'victim@x.com', password } })
    for (let i = 0; i < 3; i++) expect((await go('bad')).statusCode).toBe(401)
    const locked = await go('password1')
    expect(locked.statusCode).toBe(429) // even the right password is refused while locked
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
    vi.setSystemTime(Date.now() + 61_000)
    expect((await go('bad')).statusCode).toBe(401) // 4th failure: lock doubles to 2 minutes
    vi.setSystemTime(Date.now() + 61_000)
    expect((await go('password1')).statusCode).toBe(429) // 1 minute was not enough any more
    vi.setSystemTime(Date.now() + 61_000)
    expect((await go('password1')).statusCode).toBe(200)
    expect((await go('bad')).statusCode).toBe(401) // success cleared the history
  })

  it('cannot be wiped by spraying other emails', async () => {
    const { app, mkUser } = await track({ rateLimitMax: 3 })
    await mkUser('target@x.com')
    let ip = 0
    const go = (email: string) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.2.${Math.floor(++ip / 200)}.${ip % 200}`, payload: { email, password: 'bad' } })
    for (let i = 0; i < 3; i++) await go('target@x.com')
    for (let i = 0; i < 60; i++) await go(`junk${i}@x.com`)
    expect((await go('target@x.com')).statusCode).toBe(429)
  })
})

describe('first-run setup code', () => {
  const body = { email: 'a@x.com', name: 'A', password: 'password1' }

  it('requires SETUP_TOKEN when it is set', async () => {
    const { app } = await track({}, false)
    const post = (payload: any) => app.inject({ method: 'POST', url: '/api/auth/setup', payload })
    expect((await post(body)).statusCode).toBe(403)
    expect((await post({ ...body, setupCode: 'nope' })).statusCode).toBe(403)
    expect((await post({ ...body, setupCode: 12345 })).statusCode).toBe(403)
    expect((await app.inject('/api/auth/status')).json()).toEqual({ needsSetup: true })
    const ok = await post({ ...body, setupCode: 'test-setup-code' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().user.is_admin).toBe(true)
    expect((await post({ ...body, setupCode: 'test-setup-code' })).statusCode).toBe(409)
  })

  it('generates a random code and logs it when none is configured and there are no users', async () => {
    const saved = process.env.SETUP_TOKEN
    delete process.env.SETUP_TOKEN
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { app } = await track({}, false)
      const line = log.mock.calls.map(c => String(c[0])).find(l => l.startsWith('First-run setup code: '))
      expect(line).toBeTruthy()
      const code = line!.slice('First-run setup code: '.length)
      expect(code.length).toBeGreaterThanOrEqual(16)
      const post = (setupCode: string) => app.inject({ method: 'POST', url: '/api/auth/setup', payload: { ...body, setupCode } })
      expect((await post('test-setup-code')).statusCode).toBe(403) // the test env value is not accepted when unset at startup
      expect((await post(code)).statusCode).toBe(200)
      // existing installs are unaffected and print nothing
      log.mockClear()
      const used = await openDb(undefined, null)
      await migrate(used)
      await used.query("INSERT INTO users (email, name, password_hash, is_admin) VALUES ('e@x.com','E','x',true)")
      apps.push(await buildApp({ db: used, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-hard-')) }))
      expect(log.mock.calls.some(c => String(c[0]).startsWith('First-run setup code'))).toBe(false)
    } finally {
      log.mockRestore()
      process.env.SETUP_TOKEN = saved
    }
  })
})

describe('CORS', () => {
  const get = (app: App, origin?: string) => app.inject({ url: '/api/health', headers: origin ? { origin } : {} })

  it('only allows the public origin cross-origin, and same-origin keeps working', async () => {
    const { app } = await track({ publicUrl: 'https://pab.example.com' }, false)
    expect((await get(app)).statusCode).toBe(200)
    expect((await get(app)).headers['access-control-allow-origin']).toBeUndefined()
    expect((await get(app, 'https://pab.example.com')).headers['access-control-allow-origin']).toBe('https://pab.example.com')
    const evil = await get(app, 'https://evil.example')
    expect(evil.statusCode).toBe(200) // not rejected, the browser just gets no permission
    expect(evil.headers['access-control-allow-origin']).toBeUndefined()
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/projects', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows localhost dev origins only outside production', async () => {
    const { app } = await track({ publicUrl: 'https://pab.example.com' }, false)
    expect((await get(app, 'http://localhost:5173')).headers['access-control-allow-origin']).toBe('http://localhost:5173')
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect((await get(app, 'http://localhost:5173')).headers['access-control-allow-origin']).toBeUndefined()
      expect((await get(app, 'https://pab.example.com')).headers['access-control-allow-origin']).toBe('https://pab.example.com')
    } finally { process.env.NODE_ENV = env }
  })
})

describe('page and socket DoS limits', () => {
  it('rejects a huge page range for replace without expanding it', async () => {
    const { app, admin, api } = await track({})
    const pid = (await api('POST', '/api/projects', admin, { name: 'P' })).json().id
    const mp = (fields: Record<string, string>, file: Buffer) => Buffer.concat([
      ...Object.entries(fields).map(([k, v]) => Buffer.from(`--B\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
      Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n'), file, Buffer.from('\r\n--B--\r\n')])
    const send = (url: string, payload: Buffer) => app.inject({ method: 'POST', url, payload, headers: { ...bearer(admin), 'content-type': 'multipart/form-data; boundary=B' } })
    const doc = (await send(`/api/projects/${pid}/documents`, mp({}, await makePdf(3)))).json().id
    const t = Date.now()
    const huge = await send(`/api/documents/${doc}/pages/replace`, mp({ pages: '1-999999999' }, await makePdf(1, 'r')))
    expect(huge.statusCode).toBe(400)
    expect(Date.now() - t).toBeLessThan(3000)
    const ok = await send(`/api/documents/${doc}/pages/replace`, mp({ pages: '2' }, await makePdf(1, 'r2')))
    expect(ok.statusCode, ok.body).toBe(200)
  })

  describe('websockets', () => {
    let app: App, port = 0, token = '', doc = ''
    const socks: WebSocket[] = []
    beforeAll(async () => {
      const f = await track({ maxSocketsPerUser: 3 })
      app = f.app; token = f.admin
      await app.listen({ port: 0, host: '127.0.0.1' })
      port = (app.server.address() as any).port
      const pid = (await f.api('POST', '/api/projects', f.admin, { name: 'P' })).json().id
      const body = Buffer.concat([Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n'), await makePdf(1), Buffer.from('\r\n--B--\r\n')])
      doc = (await app.inject({ method: 'POST', url: `/api/projects/${pid}/documents`, payload: body, headers: { ...bearer(token), 'content-type': 'multipart/form-data; boundary=B' } })).json().id
    })
    afterAll(() => { for (const s of socks) s.terminate() })

    const connect = (t = token) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${t}`)
      socks.push(ws)
      const msgs: any[] = []
      ws.on('message', d => msgs.push(JSON.parse(String(d))))
      const closed = new Promise<number>(r => ws.on('close', c => r(c)))
      const opened = new Promise<void>(r => ws.on('open', () => r()))
      return { ws, msgs, closed, opened }
    }
    const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 10)) }

    it('caps open sockets per user and rate-limits joins', async () => {
      const a = connect(), b = connect(), c = connect()
      await Promise.all([a.opened, b.opened, c.opened])
      await new Promise(r => setTimeout(r, 200)) // let all three authenticate and register
      const d = connect()
      expect(await d.closed).toBe(4429)
      // the first three still work: joins beyond the allowance are refused
      for (let i = 0; i < 30; i++) a.ws.send(JSON.stringify({ type: 'join', documentId: doc }))
      await until(() => a.msgs.some(m => m.type === 'error'))
      expect(a.msgs.find(m => m.type === 'error').message).toBe('Too many join requests')
      expect(a.msgs.filter(m => m.type === 'error').length).toBeLessThanOrEqual(10)
      // closing one frees a slot
      b.ws.close(); await b.closed
      await new Promise(r => setTimeout(r, 100))
      const e = connect()
      await e.opened
      await new Promise(r => setTimeout(r, 200))
      expect(e.ws.readyState).toBe(WebSocket.OPEN)
    })
  })
})

describe('set-based writes', () => {
  it('writes a multi-page scale in one statement and updates existing rows', async () => {
    const { app, admin, api } = await track({})
    const pid = (await api('POST', '/api/projects', admin, { name: 'P' })).json().id
    const body = Buffer.concat([Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n'), await makePdf(3), Buffer.from('\r\n--B--\r\n')])
    const doc = (await app.inject({ method: 'POST', url: `/api/projects/${pid}/documents`, payload: body, headers: { ...bearer(admin), 'content-type': 'multipart/form-data; boundary=B' } })).json().id
    await api('PUT', `/api/documents/${doc}/scales/2`, admin, { points_per_foot: 1, label: 'old' })
    const pages = Array.from({ length: 400 }, (_, i) => 400 - i) // unsorted, large
    const r = await api('PUT', `/api/documents/${doc}/scales`, admin, { points_per_foot: 8, label: 'bulk', pages: [...pages, 5, 5] })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toHaveLength(400)
    expect(r.json()[0]).toMatchObject({ page: 1, points_per_foot: 8, label: 'bulk' })
    const all = (await api('GET', `/api/documents/${doc}/scales`, admin)).json()
    expect(all).toHaveLength(400)
    expect(all.find((s: any) => s.page === 2)).toMatchObject({ points_per_foot: 8, label: 'bulk' })
  })
})
