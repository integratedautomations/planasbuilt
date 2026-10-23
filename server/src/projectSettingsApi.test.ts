import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, migrate } from './db.js'
import { buildApp } from './app.js'
import { setTransportFactory } from './mail.js'
import { makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
const tok: Record<string, string> = {}
let pid = '', docId = '', camSet = '', faSet = ''
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who: string, payload?: any) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok[who]}` } })
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const device = (extra: any = {}) => ({ type: 'device', page: 1, geometry: { x: 10, y: 20, w: 30, h: 30 }, symbol_set_id: camSet, status: 'planned', fields: {}, ...extra })
const putMarkup = (who: string, id: string, extra: any = {}, doc = docId) => call('PUT', `/api/documents/${doc}/markups/${id}`, who, device(extra))
const settings = async (patch: any, who = 'admin') => call('PUT', `/api/projects/${pid}/settings`, who, patch)

function multipart(name: string, filename: string, type: string, bytes: Buffer, boundary = 'BB', fields: Record<string, string> = {}) {
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  }
}
const upload = (url: string, who: string, name: string, filename: string, type: string, bytes: Buffer, fields: Record<string, string> = {}) => {
  const m = multipart(name, filename, type, bytes, 'BB', fields)
  return app.inject({ method: 'POST', url, payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${tok[who]}` } })
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-ps-')) })
  tok.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann', password: 'password1', setupCode: 'test-setup-code' } })).json().token
  pid = (await call('POST', '/api/projects', 'admin', { name: 'P' })).json().id
  for (const r of ['editor', 'field']) {
    await call('POST', '/api/users', 'admin', { email: `${r}@x.com`, name: r, password: 'password1' })
    tok[r] = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${r}@x.com`, password: 'password1' } })).json().token
    await call('PUT', `/api/projects/${pid}/members`, 'admin', { email: `${r}@x.com`, role: r })
  }
  const sets = (await call('GET', '/api/symbol-sets', 'admin')).json()
  camSet = sets.find((s: any) => s.name === 'Cameras').id
  faSet = sets.find((s: any) => s.name === 'Fire Alarm').id
  const m = multipart('file', 'a.pdf', 'application/pdf', await makePdf(1), 'XX')
  docId = (await app.inject({ method: 'POST', url: `/api/projects/${pid}/documents`, payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${tok.admin}` } })).json().id
})
afterAll(async () => { await app.close() })

describe('project settings api', () => {
  it('shows defaults and only project admins may change them', async () => {
    const p = (await call('GET', `/api/projects/${pid}`, 'editor')).json()
    expect(p.settings.statuses.map((s: any) => s.key)).toEqual(['planned', 'installed', 'tested', 'punch'])
    expect(p.settings.report.has_logo).toBe(false)
    expect(JSON.stringify(p)).not.toContain('logo_key')
    expect((await settings({ tag_format: 'plain' }, 'editor')).statusCode).toBe(403)
    expect((await settings({ tag_format: 'plain' }, 'field')).statusCode).toBe(403)
    expect((await settings({ tag_format: 'bogus' })).statusCode).toBe(400)
  })
})

describe('status workflow', () => {
  it('uses the project status list and keeps statuses that are in use', async () => {
    expect((await putMarkup('admin', uid(1), { status: 'rough' })).statusCode).toBe(400)
    const list = [{ key: 'planned', label: 'Planned', color: '#868e96' }, { key: 'rough', label: 'Rough-in', color: '#f08c00' }, { key: 'installed', label: 'Installed', color: '#1971c2' }]
    expect((await settings({ statuses: list })).statusCode).toBe(200)
    expect((await putMarkup('admin', uid(1), { status: 'rough' })).statusCode).toBe(200)
    expect((await putMarkup('admin', uid(2), { status: 'tested' })).statusCode).toBe(400) // removed from the list
    // 'installed' is used by nothing yet, 'rough' is used: it cannot go
    const r = await settings({ statuses: list.filter(s => s.key !== 'rough') })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain('rough')
    expect((await call('GET', `/api/projects/${pid}`, 'editor')).json().settings.statuses.map((s: any) => s.key)).toEqual(['planned', 'rough', 'installed'])
  })
  it('lets a device keep a status that was later removed from the list', async () => {
    await putMarkup('admin', uid(3), { status: 'installed' })
    await putMarkup('admin', uid(3), { status: 'planned' }) // not in use any more
    const keepRough = [{ key: 'planned', label: 'Planned', color: '#868e96' }, { key: 'rough', label: 'Rough-in', color: '#f08c00' }]
    expect((await settings({ statuses: keepRough })).statusCode).toBe(200)
    expect((await putMarkup('admin', uid(3), { status: 'planned', text: 'edited' })).statusCode).toBe(200)
  })
})

describe('required fields', () => {
  it('blocks a status change until the fields and photo exist, naming what is missing', async () => {
    await settings({ statuses: [{ key: 'planned', label: 'Planned', color: '#868e96' }, { key: 'installed', label: 'Installed', color: '#1971c2' }, { key: 'rough', label: 'Rough-in', color: '#f08c00' }] })
    expect((await settings({ required: { installed: ['ip', 'serial', 'photo'] } })).statusCode).toBe(200)
    const id = uid(10)
    expect((await putMarkup('admin', id, { status: 'planned' })).statusCode).toBe(200)
    const r = await putMarkup('admin', id, { status: 'installed' })
    expect(r.statusCode).toBe(422)
    expect(r.json().missing.map((m: any) => m.key)).toEqual(['ip', 'serial', 'photo'])
    expect(r.json().error).toContain('IP address')
    expect(r.json().error).toContain('Serial #')
    expect(r.json().error).toContain('a photo')
    // the stored status did not change
    const list = (await call('GET', `/api/documents/${docId}/markups`, 'admin')).json()
    expect(list.find((m: any) => m.id === id).status).toBe('planned')
    const partly = await putMarkup('admin', id, { status: 'installed', fields: { ip: '10.0.0.5', serial: 'S1' } })
    expect(partly.json().missing.map((m: any) => m.key)).toEqual(['photo'])
    // photos still waiting in the offline queue count (the client says how many)
    expect((await putMarkup('admin', id, { status: 'installed', fields: { ip: '10.0.0.5', serial: 'S1' }, pending_photos: 1 })).statusCode).toBe(200)
  })
  it('counts uploaded photos and enforces for field users too', async () => {
    const id = uid(11)
    await putMarkup('admin', id, { status: 'planned', fields: { ip: '10.0.0.6', serial: 'S2' } })
    expect((await putMarkup('field', id, { status: 'installed', fields: { ip: '10.0.0.6', serial: 'S2' } })).statusCode).toBe(422)
    const up = await upload(`/api/markups/${id}/attachments`, 'admin', 'photo', 'p.png', 'image/png', png, { id: uid(900) })
    expect(up.statusCode, up.body).toBe(200)
    expect((await putMarkup('field', id, { status: 'installed', fields: { ip: '10.0.0.6', serial: 'S2' } })).statusCode).toBe(200)
  })
  it('only checks on a status change, and skips fields the device does not have', async () => {
    const id = uid(12)
    await putMarkup('admin', id, { status: 'planned' })
    await settings({ required: {} })
    await putMarkup('admin', id, { status: 'installed' })
    await settings({ required: { installed: ['ip', 'photo'] } })
    expect((await putMarkup('admin', id, { status: 'installed', text: 'still editable' })).statusCode).toBe(200)
    await settings({ required: { installed: ['not_a_field_of_cameras'] } })
    expect((await putMarkup('admin', uid(13), { status: 'installed' })).statusCode).toBe(200)
    await settings({ required: { installed: ['tag'] } })
    expect((await putMarkup('admin', uid(14), { status: 'installed' })).statusCode).toBe(200) // tag is numbered by the server first
    await settings({ required: {} })
  })
})

describe('tag format, gap filling and prefixes', () => {
  const tagOf = async (id: string) => (await call('GET', `/api/documents/${docId}/markups`, 'admin')).json().find((m: any) => m.id === id)?.tag
  const mk = async (n: number, extra: any = {}) => { const r = await putMarkup('admin', uid(n), { symbol_set_id: faSet, ...extra }); expect(r.statusCode, r.body).toBe(200); return r.json().tag as string }

  it('uses the organization digits by default and the project format when set', async () => {
    expect(await mk(100, { status: 'planned' })).toBe('FA-01')
    expect(await mk(101)).toBe('FA-02')
    await settings({ tag_format: 'dash3' })
    expect(await mk(102)).toBe('FA-003')
    await settings({ tag_format: 'plain' })
    expect(await mk(103)).toBe('FA4') // continues past the FA-0x tags of either style
    expect(await mk(104)).toBe('FA5')
  })
  it('fills gaps when asked, otherwise continues from the highest', async () => {
    await call('DELETE', `/api/documents/${docId}/markups/${uid(101)}`, 'admin') // CAM-02 freed
    expect(await mk(105)).toBe('FA6')
    await settings({ tag_fill_gaps: true })
    expect(await mk(106)).toBe('FA2')
    expect(await mk(107)).toBe('FA7')
    await settings({ tag_fill_gaps: false, tag_format: 'dash2' })
  })
  it('applies a per-project prefix for a symbol set, and renumbers a duplicate typed tag in the same format', async () => {
    expect((await settings({ tag_prefixes: { [faSet]: 'cm' } })).json().tag_prefixes).toEqual({ [faSet]: 'CM' })
    expect(await mk(110)).toBe('CM-01')
    expect(await mk(111)).toBe('CM-02')
    const dup = await mk(112, { tag: 'CM-01' })
    expect(dup).toBe('CM-03')
    expect((await settings({ tag_prefixes: { [faSet]: '' } })).json().tag_prefixes).toEqual({})
    expect(await tagOf(uid(110))).toBe('CM-01')
  })
})

describe('project lock', () => {
  it('stops everyone but admins from changing a locked project', async () => {
    const id = uid(200)
    expect((await settings({ locked: true })).json().locked).toBe(true)
    expect((await call('GET', `/api/projects/${pid}`, 'editor')).json().settings.locked).toBe(true)
    const e = await putMarkup('editor', id)
    expect(e.statusCode).toBe(403)
    expect(e.json().error).toContain('locked')
    expect((await putMarkup('field', uid(100), { status: 'planned' })).statusCode).toBe(403)
    expect((await call('DELETE', `/api/documents/${docId}/markups/${uid(100)}`, 'editor')).statusCode).toBe(403)
    expect((await call('PATCH', `/api/projects/${pid}`, 'editor', { status: 'completed' })).statusCode).toBe(403)
    // reading still works for everyone, and admins keep editing
    expect((await call('GET', `/api/documents/${docId}/markups`, 'editor')).statusCode).toBe(200)
    expect((await putMarkup('admin', id)).statusCode).toBe(200)
    expect((await settings({ locked: false })).json().locked).toBe(false)
    expect((await putMarkup('editor', uid(201))).statusCode).toBe(200)
  })
})

describe('report sections, photo quality and logo', () => {
  it('stores report sections and photo quality, and serves the project logo with an organization fallback', async () => {
    const r = await settings({ report: { sections: { bom: false, wiring: false } }, photo_quality: 0.6 })
    expect(r.json()).toMatchObject({ photo_quality: 0.6, report: { sections: { bom: false, wiring: false, photos: true } } })
    expect((await settings({ photo_quality: 2 })).statusCode).toBe(400)
    expect((await call('GET', `/api/projects/${pid}/logo`, 'editor')).statusCode).toBe(404)
    // organization logo is the fallback
    expect((await upload('/api/settings/logo', 'admin', 'file', 'l.png', 'image/png', png)).statusCode).toBe(200)
    const org = await call('GET', `/api/projects/${pid}/logo`, 'editor')
    expect(org.statusCode).toBe(200)
    expect(org.headers['content-type']).toBe('image/png')
    // the project's own logo wins; only project admins can set it
    expect((await upload(`/api/projects/${pid}/logo`, 'editor', 'file', 'l.png', 'image/png', png)).statusCode).toBe(403)
    expect((await upload(`/api/projects/${pid}/logo`, 'admin', 'file', 'l.txt', 'text/plain', Buffer.from('hello world, not an image'))).statusCode).toBe(400)
    const up = await upload(`/api/projects/${pid}/logo`, 'admin', 'file', 'l.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]))
    expect(up.statusCode, up.body).toBe(200)
    expect(up.json().report.has_logo).toBe(true)
    expect((await call('GET', `/api/projects/${pid}/logo`, 'editor')).headers['content-type']).toBe('image/jpeg')
    expect((await call('DELETE', `/api/projects/${pid}/logo`, 'admin')).json().report.has_logo).toBe(false)
    expect((await call('GET', `/api/projects/${pid}/logo`, 'editor')).headers['content-type']).toBe('image/png')
  })
})

describe('organization settings', () => {
  const put = (patch: any) => call('PUT', '/api/settings', 'admin', patch)

  it('validates and clamps the new sections, and only admins may read or write them', async () => {
    expect((await call('PUT', '/api/settings', 'editor', { uploads: { max_upload_mb: 5 } })).statusCode).toBe(403)
    const r = await put({ security: { session_days: 9999, lockout_limit: 1, lockout_base_min: 0, lockout_cap_min: 99999 }, uploads: { max_upload_mb: 0 } })
    expect(r.statusCode).toBe(200)
    expect(r.json().security).toEqual({ session_days: 365, lockout_limit: 3, lockout_base_min: 1, lockout_cap_min: 1440 })
    expect(r.json().uploads.max_upload_mb).toBe(1)
    await put({ security: { session_days: 30, lockout_limit: 0, lockout_base_min: 1, lockout_cap_min: 15 }, uploads: { max_upload_mb: 200 } })
  })
  it('rejects invite templates without a link or with unknown placeholders', async () => {
    expect((await put({ invite: { body: 'Hello, welcome.' } })).statusCode).toBe(400)
    const bad = await put({ invite: { body: 'Hi {nmae}: {link}' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toContain('{nmae}')
    expect((await put({ invite: { subject: '  ' } })).statusCode).toBe(400)
  })
  it('signs sessions for the configured number of days', async () => {
    const exp = async () => {
      const t = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'password1' } })).json().token
      const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString())
      return Math.round((p.exp - p.iat) / 86400)
    }
    expect(await exp()).toBe(30)
    await put({ security: { session_days: 7 } })
    expect(await exp()).toBe(7)
    await put({ security: { session_days: 30 } })
  })
  it('enforces the maximum upload size', async () => {
    await put({ uploads: { max_upload_mb: 1 } })
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_100_000, 32)])
    const r = await upload(`/api/projects/${pid}/documents`, 'admin', 'file', 'big.pdf', 'application/pdf', big)
    expect(r.statusCode).toBe(413)
    expect(r.json().error).toContain('1 MB')
    expect((await upload(`/api/projects/${pid}/documents`, 'admin', 'file', 'ok.pdf', 'application/pdf', await makePdf(1, 'small'))).statusCode).toBe(200)
    await put({ uploads: { max_upload_mb: 200 } })
  })
  it('locks accounts at the configured limit', async () => {
    await call('POST', '/api/users', 'admin', { email: 'lock@x.com', name: 'L', password: 'password1' })
    await put({ security: { lockout_limit: 3, lockout_base_min: 5, lockout_cap_min: 30 } })
    const bad = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock@x.com', password: 'wrong-password' } })
    expect((await bad()).statusCode).toBe(401)
    expect((await bad()).statusCode).toBe(401)
    expect((await bad()).statusCode).toBe(401) // the third failure locks
    const locked = await bad()
    expect(locked.statusCode).toBe(429)
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(200) // about the 5 minute base, not the default minute
    const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock@x.com', password: 'password1' } })
    expect(good.statusCode).toBe(429)
    await put({ security: { lockout_limit: 0, lockout_base_min: 1, lockout_cap_min: 15 } })
  })
  it('emails invites from the configured template and sender name', async () => {
    const sent: any[] = []
    setTransportFactory(() => ({ sendMail: async o => { sent.push(o) } }))
    await put({ smtp: { host: 'smtp.example.com', port: 587, from: 'a@x.com' }, company: { name: 'Acme Security' } })
    expect((await put({ invite: { sender_name: 'The Acme Team', subject: 'Welcome {name} to {company}', body: 'Hi {name},\n{inviter} added you.\n{link}\nExpires in {days} days.' } })).statusCode).toBe(200)
    const r = await call('POST', '/api/invites', 'admin', { email: 'newbie@x.com', name: 'Newbie', role: 'user' })
    expect(r.json().emailed).toBe(true)
    expect(sent.at(-1).subject).toBe('Welcome Newbie to Acme Security')
    expect(sent.at(-1).text).toMatch(/^Hi Newbie,\nThe Acme Team added you\.\nhttp.*\/invite\/[\w-]+\nExpires in 7 days\.$/)
  })
  it('copies the organization defaults into new projects only', async () => {
    const r = await put({ project_defaults: {
      statuses: [{ key: 'todo', label: 'To do', color: '#111111' }, { key: 'done', label: 'Done', color: '#222222' }],
      required: { done: ['photo'] }, tag_format: 'plain', tag_fill_gaps: true, photo_quality: 0.5,
      report: { sections: { bom: false } },
    } })
    expect(r.statusCode, r.body).toBe(200)
    const created = (await call('POST', '/api/projects', 'admin', { name: 'New one' })).json()
    expect(created.settings).toMatchObject({
      statuses: [{ key: 'todo' }, { key: 'done' }], required: { done: ['photo'] }, tag_format: 'plain', tag_fill_gaps: true, photo_quality: 0.5, locked: false,
      report: { sections: { bom: false, photos: true } },
    })
    // the earlier project keeps its own settings
    expect((await call('GET', `/api/projects/${pid}`, 'admin')).json().settings.tag_format).toBe('dash2')
    // and changing a project does not change the defaults
    await call('PUT', `/api/projects/${created.id}/settings`, 'admin', { tag_format: 'dash3' })
    expect((await call('GET', '/api/settings', 'admin')).json().project_defaults.tag_format).toBe('plain')
    expect((await put({ project_defaults: { statuses: [] } })).statusCode).toBe(400)
  })
})
