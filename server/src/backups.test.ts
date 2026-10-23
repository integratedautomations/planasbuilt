import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import {
  buildConfig, cleanPath, decryptSecret, encryptSecret, obscure, parseToken, registerBackups, reveal,
} from './backups.js'
import type { Target } from './backups.js'

const KEY_ENV = { BACKUP_ENCRYPTION_KEY: 'k'.repeat(40) } as NodeJS.ProcessEnv
const enc = (s: string) => encryptSecret(s, KEY_ENV)
const dec = (s: string) => decryptSecret(s, KEY_ENV)

describe('rclone obscure', () => {
  it('reveals a value produced by `rclone obscure`', () => {
    // rclone obscure 'hunter2 pässword' (rclone 1.60.1)
    expect(reveal('26I0w3KrAq9ayUZd4NLOmaCjgO28R8lZYlTsdJMDinb_')).toBe('hunter2 pässword')
  })
  it('round trips and uses a random IV', () => {
    const iv = Buffer.alloc(16, 7)
    expect(obscure('abc', iv)).toBe(obscure('abc', iv))
    expect(reveal(obscure('p@ss/w0rd "quoted"'))).toBe('p@ss/w0rd "quoted"')
    expect(obscure('x')).not.toBe(obscure('x'))
  })
  it('has the rclone layout: IV first, base64url without padding', () => {
    expect(obscure('', Buffer.alloc(16))).toBe('AAAAAAAAAAAAAAAAAAAAAA')
  })
})

describe('secret encryption', () => {
  it('round trips and detects tampering / wrong key', () => {
    const b = enc('s3cret ✓')
    expect(b).not.toContain('s3cret')
    expect(dec(b)).toBe('s3cret ✓')
    expect(() => decryptSecret(b, { BACKUP_ENCRYPTION_KEY: 'z'.repeat(40) } as any)).toThrow(/cannot be decrypted/)
    const parts = b.split('.'); parts[3] = Buffer.from('tampered').toString('base64')
    expect(() => dec(parts.join('.'))).toThrow()
  })
  it('refuses without a usable key', () => {
    expect(() => encryptSecret('x', {} as any)).toThrow(/BACKUP_ENCRYPTION_KEY/)
    expect(() => encryptSecret('x', { BACKUP_ENCRYPTION_KEY: 'short' } as any)).toThrow(/BACKUP_ENCRYPTION_KEY/)
  })
})

const base = (o: Partial<Target>): Target => ({
  id: 'abcd1234', name: 'T', type: 'sftp', enabled: true, path: 'pab', retention_days: 30,
  config: {}, secrets: {}, crypt: { enabled: false, password: '' }, ...o,
})

describe('config generation', () => {
  it('writes sftp with an obscured password', () => {
    const { conf, targets } = buildConfig([base({ config: { host: 'h.example.com', port: '2222', user: 'bob' }, secrets: { pass: enc('pw 1') } })], dec)
    expect(conf).toContain('[tabcd1234]')
    expect(conf).toContain('type = sftp')
    expect(conf).toContain('port = 2222')
    const pass = /^pass = (.+)$/m.exec(conf)![1]
    expect(pass).not.toContain('pw 1')
    expect(reveal(pass)).toBe('pw 1')
    expect(targets[0]).toMatchObject({ id: 'abcd1234', remote: 'tabcd1234:pab', retention_days: 30, enabled: true })
    expect(JSON.stringify(targets)).not.toContain('pass')
  })
  it('writes s3 with the bucket in the remote path', () => {
    const { conf, targets } = buildConfig([base({ type: 's3', path: 'nightly', config: { provider: 'Other', endpoint: 'https://s3.x.com', region: '', access_key_id: 'AK', bucket: 'bk' }, secrets: { secret_access_key: enc('SK') } })], dec)
    expect(conf).toContain('secret_access_key = SK')
    expect(conf).toContain('force_path_style = true')
    expect(targets[0].remote).toBe('tabcd1234:bk/nightly')
  })
  it('writes an oauth token on one line and wraps with crypt', () => {
    const tok = JSON.stringify({ access_token: 'a', refresh_token: 'r', expiry: '2030-01-01T00:00:00Z' })
    const { conf, targets } = buildConfig([base({ type: 'drive', config: {}, secrets: { token: enc(tok) }, crypt: { enabled: true, password: enc('crypt pw') } })], dec)
    expect(conf).toContain(`token = ${tok}`)
    expect(conf).toContain('[tabcd1234c]')
    expect(conf).toContain('type = crypt')
    expect(conf).toContain('remote = tabcd1234:pab')
    expect(reveal(/^password = (.+)$/m.exec(conf)![1])).toBe('crypt pw')
    expect(targets[0].remote).toBe('tabcd1234c:')
  })
})

describe('helpers', () => {
  it('parses tokens from raw JSON or authorize output', () => {
    const j = '{"access_token":"a","token_type":"Bearer","refresh_token":"r"}'
    expect(JSON.parse(parseToken(j)!)).toMatchObject({ access_token: 'a' })
    expect(parseToken(`Paste the following into your remote machine --->\n${j}\n<---End paste`)).toBeTruthy()
    expect(parseToken('nope')).toBeNull()
    expect(parseToken('{"x":1}')).toBeNull()
  })
  it('cleans paths', () => {
    expect(cleanPath('/a//b/', 's3')).toBe('a/b')
    expect(cleanPath('/home/x', 'sftp')).toBe('/home/x')
    expect(cleanPath('a/../b', 's3')).toBeNull()
  })
})

describe('admin routes', () => {
  let db: Awaited<ReturnType<typeof openDb>>
  let dir: string
  const calls: string[][] = []
  let fail = false
  const build = async (env: NodeJS.ProcessEnv) => {
    const app = Fastify()
    const auth = async (req: any, reply: any) => {
      const h = req.headers.authorization
      if (!h) return reply.code(401).send({ error: 'no' })
      req.user = { id: 'u', isAdmin: h === 'admin' }
    }
    await registerBackups({
      app, db, auth, dir, env,
      rclone: async args => { calls.push(args); return fail ? { ok: false, output: 'boom: connection refused' } : { ok: true, output: '' } },
      resolveOneDrive: async () => ({ drive_id: 'DID', drive_type: 'personal' }),
    })
    return app
  }
  const A = { authorization: 'admin' }
  const U = { authorization: 'user' }
  const sftp = { type: 'sftp', name: 'NAS', path: 'pab', config: { host: 'nas', user: 'bob' }, secrets: { pass: 'pw' } }

  beforeAll(async () => { db = await openDb(undefined, null); await migrate(db) })
  beforeEach(async () => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-bk-')), '.rclone')
    calls.length = 0; fail = false
    await db.query(`DELETE FROM settings WHERE key = 'backups'`)
  })

  it('is admin only', async () => {
    const app = await build(KEY_ENV)
    for (const [method, url] of [['GET', '/api/admin/backups'], ['GET', '/api/admin/backups/status'], ['POST', '/api/admin/backups/targets'],
      ['PUT', '/api/admin/backups/targets/abcd1234'], ['DELETE', '/api/admin/backups/targets/abcd1234'],
      ['POST', '/api/admin/backups/targets/abcd1234/test'], ['POST', '/api/admin/backups/run-now']] as const) {
      expect((await app.inject({ method, url, payload: sftp })).statusCode, `${method} ${url} anon`).toBe(401)
      expect((await app.inject({ method, url, headers: U, payload: sftp })).statusCode, `${method} ${url} user`).toBe(403)
    }
    expect(existsSync(dir)).toBe(false)
  })

  it('is registered in the real app and admin only there', async () => {
    const real = await openDb(undefined, null); await migrate(real)
    const app = await buildApp({ db: real, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-bkapp-')) })
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'boss@x.com', name: 'Boss', password: 'password1', setupCode: 'test-setup-code' } })).json().token
    await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${admin}` }, payload: { email: 'u@x.com', name: 'U', password: 'password1' } })
    const ut = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'u@x.com', password: 'password1' } })).json().token
    expect((await app.inject({ url: '/api/admin/backups', headers: { authorization: `Bearer ${ut}` } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/admin/backups', headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(200)
  })

  it('refuses to save secrets without BACKUP_ENCRYPTION_KEY', async () => {
    const app = await build({} as any)
    const r = await app.inject({ method: 'POST', url: '/api/admin/backups/targets', headers: A, payload: sftp })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain('BACKUP_ENCRYPTION_KEY')
    expect((await app.inject({ url: '/api/admin/backups', headers: A })).json()).toMatchObject({ encryption_ready: false, targets: [] })
  })

  it('creates, never returns secrets, writes a mode-600 config, updates and deletes', async () => {
    const app = await build(KEY_ENV)
    const c = await app.inject({ method: 'POST', url: '/api/admin/backups/targets', headers: A, payload: sftp })
    expect(c.statusCode).toBe(201)
    const t = c.json()
    expect(t.warning).toBeNull()
    expect(t.has_secret).toEqual({ pass: true, key_pem: false })
    expect(t.retention_days).toBe(30)
    const list = await app.inject({ url: '/api/admin/backups', headers: A })
    expect(JSON.stringify(list.json())).not.toContain('"pw"')
    expect(list.json().encryption_ready).toBe(true)
    const [row] = await db.query(`SELECT value FROM settings WHERE key = 'backups'`)
    expect(JSON.stringify(row.value)).not.toContain('"pw"')
    expect(decryptSecret(row.value.targets[0].secrets.pass, KEY_ENV)).toBe('pw')
    const conf = path.join(dir, 'rclone.conf')
    expect(readFileSync(conf, 'utf8')).toContain('host = nas')
    if (process.platform !== 'win32') expect(statSync(conf).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path.join(dir, 'targets.json'), 'utf8'))[0]).toMatchObject({ id: t.id, remote: `t${t.id}:pab`, retention_days: 30 })

    const u = await app.inject({ method: 'PUT', url: `/api/admin/backups/targets/${t.id}`, headers: A, payload: { enabled: false, retention_days: 7, secrets: { pass: '' } } })
    expect(u.statusCode).toBe(200)
    expect(u.json()).toMatchObject({ enabled: false, retention_days: 7, has_secret: { pass: true } })
    expect(JSON.parse(readFileSync(path.join(dir, 'targets.json'), 'utf8'))[0].enabled).toBe(false)

    expect((await app.inject({ method: 'DELETE', url: `/api/admin/backups/targets/${t.id}`, headers: A })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/admin/backups', headers: A })).json().targets).toEqual([])
    expect(readFileSync(conf, 'utf8')).toBe('')
  })

  it('validates input', async () => {
    const app = await build(KEY_ENV)
    const post = (p: any) => app.inject({ method: 'POST', url: '/api/admin/backups/targets', headers: A, payload: p })
    expect((await post({ ...sftp, type: 'ftp' })).statusCode).toBe(400)
    expect((await post({ ...sftp, secrets: {} })).statusCode).toBe(400)
    expect((await post({ ...sftp, path: '../x' })).statusCode).toBe(400)
    expect((await post({ ...sftp, retention_days: -1 })).statusCode).toBe(400)
    expect((await post({ type: 'drive', name: 'G', secrets: { token: 'garbage' } })).statusCode).toBe(400)
    expect((await post({ ...sftp, crypt: { enabled: true } })).statusCode).toBe(400)
    const ok = await post({ type: 'drive', name: 'G', secrets: { token: 'text {"access_token":"a","refresh_token":"r"} text' }, crypt: { enabled: true, password: 'pp' } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().crypt).toEqual({ enabled: true, has_password: true })
    expect(readFileSync(path.join(dir, 'rclone.conf'), 'utf8')).toContain('type = crypt')
  })

  it('resolves the OneDrive drive id from the token', async () => {
    const app = await build(KEY_ENV)
    const r = await app.inject({ method: 'POST', url: '/api/admin/backups/targets', headers: A, payload: { type: 'onedrive', name: 'OD', secrets: { token: '{"access_token":"a"}' } } })
    expect(r.statusCode).toBe(201)
    expect(r.json().config).toMatchObject({ drive_id: 'DID', drive_type: 'personal' })
  })

  it('tests a connection with rclone and reports errors', async () => {
    const app = await build(KEY_ENV)
    const t = (await app.inject({ method: 'POST', url: '/api/admin/backups/targets', headers: A, payload: sftp })).json()
    const ok = await app.inject({ method: 'POST', url: `/api/admin/backups/targets/${t.id}/test`, headers: A })
    expect(ok.json()).toEqual({ ok: true })
    expect(calls.map(c => (c.includes('mkdir') ? 'mkdir' : 'lsd'))).toEqual(['mkdir', 'lsd'])
    expect(calls[0]).toContain(path.join(dir, 'rclone.conf'))
    fail = true
    const bad = await app.inject({ method: 'POST', url: `/api/admin/backups/targets/${t.id}/test`, headers: A })
    expect(bad.json()).toMatchObject({ ok: false, error: expect.stringContaining('boom') })
    expect((await app.inject({ method: 'POST', url: '/api/admin/backups/targets/deadbeef/test', headers: A })).statusCode).toBe(404)
  })

  it('run-now writes the trigger; status reflects status.json', async () => {
    const app = await build(KEY_ENV)
    expect((await app.inject({ method: 'POST', url: '/api/admin/backups/run-now', headers: A })).statusCode).toBe(400)
    const t = (await app.inject({ method: 'POST', url: '/api/admin/backups/targets', headers: A, payload: sftp })).json()
    expect((await app.inject({ method: 'POST', url: '/api/admin/backups/run-now', headers: A })).json()).toEqual({ ok: true })
    expect(existsSync(path.join(dir, 'run-now'))).toBe(true)
    expect((await app.inject({ url: '/api/admin/backups', headers: A })).json().run_pending).toBe(true)
    expect((await app.inject({ url: '/api/admin/backups/status', headers: A })).json().failed).toEqual([])
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify([{ target: t.id, name: 'NAS', ok: false, at: '2026-01-01T03:00:00Z', error: 'unreachable', bytes: 0 }]))
    const s = (await app.inject({ url: '/api/admin/backups/status', headers: A })).json()
    expect(s.failed).toHaveLength(1)
    expect(s.failed[0]).toMatchObject({ error: 'unreachable', ok: false })
  })
})
