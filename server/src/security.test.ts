import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Awaited<ReturnType<typeof openDb>>
let admin = ''
let port = 0
let filesDir = ''
const objects = new Map<string, Buffer>()
const fakeS3 = () => ({
  async send(cmd: any) {
    const n = cmd.constructor.name, i = cmd.input
    if (n === 'PutObjectCommand') { objects.set(`${i.Bucket}/${i.Key}`, Buffer.from(i.Body)); return {} }
    if (n === 'HeadObjectCommand') {
      const o = objects.get(`${i.Bucket}/${i.Key}`)
      if (!o) throw Object.assign(new Error('nf'), { name: 'NotFound' })
      return { ContentLength: o.length }
    }
    if (n === 'GetObjectCommand') {
      const o = objects.get(`${i.Bucket}/${i.Key}`)
      if (!o) throw Object.assign(new Error('nf'), { name: 'NoSuchKey' })
      return { Body: { transformToByteArray: async () => new Uint8Array(o) } }
    }
    if (n === 'DeleteObjectCommand') { objects.delete(`${i.Bucket}/${i.Key}`); return {} }
    throw new Error('unexpected ' + n)
  },
})

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
const api = (method: string, url: string, token: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload, headers: { ...(token ? bearer(token) : {}), ...headers } })
const login = async (email: string, password = 'password1') =>
  (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).json().token as string
const mkUser = async (email: string, isAdmin = false) => {
  const r = await api('POST', '/api/users', admin, { email, name: email.split('@')[0], password: 'password1', isAdmin })
  expect(r.statusCode).toBe(200)
  return r.json().id as string
}
const mp = (fields: Record<string, string>, file: Buffer, name = 'a.pdf', type = 'application/pdf', part = 'file', b = 'SB') => Buffer.concat([
  ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
  Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${part}"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
  file, Buffer.from(`\r\n--${b}--\r\n`)])
const upload = (url: string, token: string, payload: Buffer) =>
  app.inject({ method: 'POST', url, payload, headers: { ...bearer(token), 'content-type': 'multipart/form-data; boundary=SB' } })

beforeAll(async () => {
  db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: (filesDir = mkdtempSync(path.join(tmpdir(), 'pm-sec-'))), s3Factory: fakeS3 })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as any).port
  admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'boss@x.com', name: 'Boss', password: 'password1' } })).json().token
})
afterAll(async () => { await app.close() })

describe('invites by project admins', () => {
  it('cannot hijack or promote a pending invite created by someone else', async () => {
    const pa = await mkUser('pa@x.com'); void pa
    const pat = await login('pa@x.com')
    const project = (await api('POST', '/api/projects', pat, { name: 'PA project' })).json().id
    const other = (await api('POST', '/api/projects', admin, { name: 'Other' })).json().id
    // an app admin invites someone as an admin
    const inv = (await api('POST', '/api/invites', admin, { email: 'pend@x.com', role: 'admin', projects: [{ id: other, role: 'viewer' }] })).json()
    const oldToken = inv.link.split('/').pop()
    const res = await api('POST', `/api/projects/${project}/invites`, pat, { email: 'pend@x.com', role: 'editor', name: 'Hacked' })
    expect(res.statusCode).toBe(409)
    // link still valid (token not regenerated), still an admin invite, name untouched, but added to the project
    expect((await app.inject(`/api/invites/${oldToken}`)).statusCode).toBe(200)
    const u = (await api('GET', `/api/users/${inv.user_id}`, admin)).json()
    expect(u).toMatchObject({ is_admin: true, status: 'invited' })
    expect(u.name).not.toBe('Hacked')
    expect(u.projects.map((p: any) => p.id).sort()).toEqual([project, other].sort())
  })

  it('never lets a project admin set isAdmin, even on their own invite', async () => {
    const pat = await login('pa@x.com')
    const project = (await api('GET', '/api/projects', pat)).json().find((p: any) => p.name === 'PA project').id
    const first = await api('POST', `/api/projects/${project}/invites`, pat, { email: 'mine@x.com', role: 'editor', isAdmin: true })
    expect(first.statusCode).toBe(200)
    const again = await api('POST', `/api/projects/${project}/invites`, pat, { email: 'mine@x.com', role: 'viewer', isAdmin: true })
    expect(again.statusCode).toBe(200) // their own invite may be re-sent
    expect((await api('GET', `/api/users/${first.json().user_id}`, admin)).json().is_admin).toBe(false)
  })
})

describe('token versioning and live admin flag', () => {
  it('drops a demoted admin immediately and rejects stale tokens', async () => {
    const id = await mkUser('adm2@x.com', true)
    const t = await login('adm2@x.com')
    expect((await api('GET', '/api/settings', t)).statusCode).toBe(200)
    expect((await api('PATCH', `/api/users/${id}`, admin, { is_admin: false })).statusCode).toBe(200)
    expect((await api('GET', '/api/projects', t)).statusCode).toBe(401) // role change signs the old token out
    const fresh = await login('adm2@x.com')
    expect((await api('GET', '/api/settings', fresh)).statusCode).toBe(403)
  })

  it('a token claiming isAdmin is not enough', async () => {
    await mkUser('plain@x.com')
    const real = await login('plain@x.com')
    const payload: any = app.jwt.decode(real)
    const forged = app.jwt.sign({ ...payload, isAdmin: true })
    expect((await api('GET', '/api/settings', forged)).statusCode).toBe(403)
  })

  it('password change and deactivation invalidate old tokens', async () => {
    const id = await mkUser('pw@x.com')
    const old = await login('pw@x.com')
    const res = await api('POST', '/api/me/password', old, { current: 'password1', password: 'password2' })
    expect(res.statusCode).toBe(200)
    expect((await api('GET', '/api/me', old)).statusCode).toBe(401)
    expect((await api('GET', '/api/me', res.json().token)).statusCode).toBe(200)
    await api('PATCH', `/api/users/${id}`, admin, { status: 'deactivated' })
    expect((await api('GET', '/api/me', res.json().token)).statusCode).toBe(401)
  })

  it('only accepts login tokens in the query on GET file routes; file tokens are scoped', async () => {
    expect((await app.inject(`/api/projects?token=${admin}`)).statusCode).toBe(401)
    const project = (await api('POST', '/api/projects', admin, { name: 'Files' })).json().id
    const pdf = await makePdf(2)
    const doc = (await upload(`/api/projects/${project}/documents`, admin, mp({}, pdf))).json()
    const ft = (await api('POST', '/api/file-token', admin)).json().ft
    const file = await app.inject(`/api/documents/${doc.id}/file?ft=${ft}`)
    expect(file.statusCode).toBe(200)
    expect(file.headers['x-content-type-options']).toBe('nosniff')
    expect(file.headers['content-disposition']).toMatch(/^inline; filename="a/)
    expect((await app.inject(`/api/documents/${doc.id}/file?token=${admin}`)).statusCode).toBe(200) // legacy
    expect((await api('GET', '/api/projects', ft)).statusCode).toBe(401) // a file token is not a login token
    expect((await app.inject(`/api/projects?ft=${ft}`)).statusCode).toBe(401)
    expect((await app.inject(`/api/documents/${doc.id}/file?ft=${admin}`)).statusCode).toBe(401) // and vice versa
  })

  it('sends security headers', async () => {
    const r = await app.inject('/api/health')
    expect(r.headers['content-security-policy']).toContain("default-src 'self'")
    expect(r.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('websocket access follows the database', () => {
  const connect = (token: string) => new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`)
    ws.on('open', () => res(ws)); ws.on('error', rej)
  })

  it('closes sockets of a deactivated user and ignores oversized frames', async () => {
    const id = await mkUser('ws1@x.com')
    const t = await login('ws1@x.com')
    const ws = await connect(t)
    const closed = new Promise<number>(r => ws.on('close', c => r(c)))
    await new Promise(r => setTimeout(r, 100))
    await api('PATCH', `/api/users/${id}`, admin, { status: 'deactivated' })
    expect(await closed).toBe(4401)

    const t2 = await login('boss@x.com')
    const big = await connect(t2)
    const bigClosed = new Promise<number>(r => big.on('close', c => r(c)))
    big.send('x'.repeat(100 * 1024))
    expect([1006, 1009]).toContain(await bigClosed)
  })

  it('removes a user from a document room when they lose project access', async () => {
    const uid = await mkUser('ws2@x.com')
    const t = await login('ws2@x.com')
    const project = (await api('POST', '/api/projects', admin, { name: 'Room' })).json().id
    await api('PUT', `/api/projects/${project}/members`, admin, { email: 'ws2@x.com', role: 'editor' })
    const doc = (await upload(`/api/projects/${project}/documents`, admin, mp({}, await makePdf(1)))).json().id
    const ws = await connect(t)
    const msgs: any[] = []
    ws.on('message', d => msgs.push(JSON.parse(String(d))))
    ws.send(JSON.stringify({ type: 'join', documentId: doc }))
    await new Promise(r => setTimeout(r, 150))
    expect(msgs.some(m => m.type === 'peers')).toBe(true)
    msgs.length = 0
    expect((await api('DELETE', `/api/projects/${project}/members/${uid}`, admin)).statusCode).toBe(200)
    await api('PUT', `/api/documents/${doc}/scales/1`, admin, { points_per_foot: 10 })
    await new Promise(r => setTimeout(r, 150))
    expect(msgs.some(m => m.type === 'scales')).toBe(false)
    ws.close()
  })
})

describe('tags', () => {
  it('allocates unique numbers under concurrency, ignores odd suffixes and rejects duplicate client tags', async () => {
    const project = (await api('POST', '/api/projects', admin, { name: 'Tags' })).json().id
    const doc = (await upload(`/api/projects/${project}/documents`, admin, mp({}, await makePdf(1)))).json().id
    const set = (await api('GET', '/api/symbol-sets', admin)).json().find((s: any) => s.tag_prefix === 'CAM')
    const body = (extra: any = {}) => ({ page: 1, type: 'point', geometry: { x: 1, y: 1 }, symbol_set_id: set.id, ...extra })
    // a pre-existing tag with a float-ish suffix must not count as 1000
    await api('PUT', `/api/documents/${doc}/markups/00000000-0000-4000-8000-0000000000aa`, admin, body({ tag: 'CAM-1e3' }))
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000010${i}`)
    const res = await Promise.all(ids.map(id => api('PUT', `/api/documents/${doc}/markups/${id}`, admin, body())))
    expect(res.map(r => r.statusCode)).toEqual(ids.map(() => 200))
    const tags = res.map(r => r.json().tag)
    expect(new Set(tags).size).toBe(8)
    expect([...tags].sort()).toEqual(['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04', 'CAM-05', 'CAM-06', 'CAM-07', 'CAM-08'])
    // duplicate client-chosen tag
    const dup = await api('PUT', `/api/documents/${doc}/markups/00000000-0000-4000-8000-0000000001ff`, admin, body({ tag: 'CAM-03' }))
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('Tag already used')
    // an update that resends its own tag, or a blank one, keeps it
    const keep = await api('PUT', `/api/documents/${doc}/markups/${ids[2]}`, admin, body({ tag: tags[2] }))
    expect(keep.json().tag).toBe(tags[2])
    const blank = await api('PUT', `/api/documents/${doc}/markups/${ids[2]}`, admin, body({ tag: '' }))
    expect(blank.json().tag).toBe(tags[2])
  })
})

describe('concurrent plan changes', () => {
  it('serialises page operations: stale ones answer 409, never silently overwrite', async () => {
    const project = (await api('POST', '/api/projects', admin, { name: 'Race' })).json().id
    const doc = (await upload(`/api/projects/${project}/documents`, admin, mp({}, await makePdf(3)))).json().id
    const rot = () => api('POST', `/api/documents/${doc}/pages/rotate`, admin, { pages: [1], degrees: 90 })
    const results = await Promise.all([rot(), rot(), rot(), rot()])
    const codes = results.map(r => r.statusCode)
    expect(codes.every(c => c === 200 || c === 409)).toBe(true)
    expect(codes.filter(c => c === 200).length).toBeGreaterThanOrEqual(1)
    const stale = results.find(r => r.statusCode === 409)
    if (stale) expect(stale.json().error).toBe('Plan changed, try again')
    const revs = (await api('GET', `/api/documents/${doc}/revisions`, admin)).json()
    expect(revs).toHaveLength(1 + codes.filter(c => c === 200).length)
  })

  it('numbers concurrent revision uploads without collisions', async () => {
    const project = (await api('POST', '/api/projects', admin, { name: 'Race2' })).json().id
    const doc = (await upload(`/api/projects/${project}/documents`, admin, mp({}, await makePdf(1)))).json().id
    const files = await Promise.all([2, 3, 4].map(n => makePdf(n)))
    const res = await Promise.all(files.map(f => upload(`/api/documents/${doc}/revisions`, admin, mp({}, f))))
    expect(res.map(r => r.statusCode)).toEqual([200, 200, 200])
    expect(res.map(r => r.json().revision).sort()).toEqual([2, 3, 4])
  })
})

describe('rate limiting and login', () => {
  it('limits logins per IP and per email, and uses one message for unknown users', async () => {
    const db2 = await openDb(undefined, null)
    await migrate(db2)
    const a2 = await buildApp({ db: db2, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-rl-')), rateLimitMax: 3 })
    const go = (email: string, remote = '10.0.0.1') => a2.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: remote, payload: { email, password: 'x' } })
    const unknown = await go('nobody@x.com', '10.0.0.2')
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json().error).toBe('Wrong email or password')
    // same email from different IPs: per-email limit kicks in on the 4th
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await go('victim@x.com', `10.0.1.${i}`)).statusCode)
    expect(codes).toEqual([401, 401, 401, 429, 429])
    // same IP, different emails: per-IP limit
    const ipCodes: number[] = []
    for (let i = 0; i < 5; i++) ipCodes.push((await go(`e${i}@x.com`, '10.0.2.1')).statusCode)
    expect(ipCodes).toEqual([401, 401, 401, 429, 429])
    await a2.close()
  })

  it('reports a deactivated account only after the correct password', async () => {
    const id = await mkUser('deact@x.com')
    await api('PATCH', `/api/users/${id}`, admin, { status: 'deactivated' })
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'deact@x.com', password: 'nope' } })
    expect(wrong.statusCode).toBe(401)
    const right = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'deact@x.com', password: 'password1' } })
    expect(right.statusCode).toBe(403)
  })
})

describe('uploads', () => {
  it('counts pages on the server and rejects non-PDFs', async () => {
    const project = (await api('POST', '/api/projects', admin, { name: 'Up' })).json().id
    const pdf = await makePdf(4)
    const ok = await upload(`/api/projects/${project}/documents`, admin, mp({ pageCount: '99' }, pdf))
    expect(ok.json().page_count).toBe(4)
    const fake = await upload(`/api/projects/${project}/documents`, admin, mp({}, Buffer.from('%PDF-1.4\nnot really')))
    expect(fake.statusCode).toBe(400)
    const text = await upload(`/api/projects/${project}/documents`, admin, mp({}, Buffer.from('hello world')))
    expect(text.statusCode).toBe(400)
    expect((await api('GET', `/api/projects/${project}/documents`, admin)).json()).toHaveLength(1) // nothing half-created
    const rev = await upload(`/api/documents/${ok.json().id}/revisions`, admin, mp({ pageCount: '1' }, await makePdf(2)))
    expect(rev.json().page_count).toBe(2)
    expect((await upload(`/api/documents/${ok.json().id}/revisions`, admin, mp({}, Buffer.from('%PDF-1.4 junk')))).statusCode).toBe(400)
  })

  it('checks photo magic bytes', async () => {
    const project = (await api('POST', '/api/projects', admin, { name: 'Photos' })).json().id
    const doc = (await upload(`/api/projects/${project}/documents`, admin, mp({}, await makePdf(1)))).json().id
    const mk = '00000000-0000-4000-8000-0000000002aa'
    await api('PUT', `/api/documents/${doc}/markups/${mk}`, admin, { page: 1, type: 'point', geometry: { x: 1, y: 1 } })
    const id = '00000000-0000-4000-8000-0000000003aa'
    const bad = await upload(`/api/markups/${mk}/attachments`, admin, mp({ id }, Buffer.from('<html>not an image</html>'), 'a.jpg', 'image/jpeg', 'photo'))
    expect(bad.statusCode).toBe(400)
    const good = await upload(`/api/markups/${mk}/attachments`, admin, mp({ id }, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'a.jpg', 'image/jpeg', 'photo'))
    expect(good.statusCode).toBe(200)
  })

  it('deletes stored files with the document, unless a snapshot still needs them', async () => {
    const project = (await api('POST', '/api/projects', admin, { name: 'Gone' })).json().id
    const created = (await upload(`/api/projects/${project}/documents`, admin, mp({}, await makePdf(1, 'gone')))).json()
    const key = ((await db.query('SELECT file_key FROM document_revisions WHERE id = $1', [created.revision_id]))[0] as any).file_key
    expect(existsSync(path.join(filesDir, key))).toBe(true)
    expect((await api('DELETE', `/api/documents/${created.id}`, admin)).statusCode).toBe(200)
    expect(existsSync(path.join(filesDir, key))).toBe(false)
  })
})

describe('members and ids', () => {
  it('will not demote the last project admin through PUT members', async () => {
    const project = (await api('POST', '/api/projects', admin, { name: 'LastAdmin' })).json().id
    const res = await api('PUT', `/api/projects/${project}/members`, admin, { email: 'boss@x.com', role: 'viewer' })
    expect(res.statusCode).toBe(400)
  })

  it('answers 404 for malformed ids and hides internals on errors', async () => {
    expect((await api('GET', '/api/documents/not-a-uuid', admin)).statusCode).toBe(404)
    expect((await api('GET', '/api/projects/xyz/members', admin)).statusCode).toBe(404)
    const project = (await api('POST', '/api/projects', admin, { name: 'Pg' })).json().id
    const doc = (await upload(`/api/projects/${project}/documents`, admin, mp({}, await makePdf(1)))).json().id
    const big = await api('PUT', `/api/documents/${doc}/markups/00000000-0000-4000-8000-0000000004aa`, admin,
      { page: 99999999999, type: 'point', geometry: { x: 1, y: 1 } })
    expect(big.statusCode).toBe(400)
  })
})

describe('s3 keys remember their bucket', () => {
  it('keeps reading files after the bucket and prefix settings change', async () => {
    const s3 = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'bucket-one', region: 'auto', accessKeyId: 'AKIA', secret: 'topsecret', pathStyle: false, prefix: 'plans' }
    expect((await api('PUT', '/api/settings', admin, { storage: { backend: 's3', s3 } })).statusCode).toBe(200)
    const project = (await api('POST', '/api/projects', admin, { name: 'S3keys' })).json().id
    const pdf = await makePdf(1, 's3')
    const created = (await upload(`/api/projects/${project}/documents`, admin, mp({}, pdf))).json()
    const [row] = await db.query<{ file_key: string }>('SELECT file_key FROM document_revisions WHERE id = $1', [created.revision_id])
    expect(row.file_key).toMatch(/^s3:bucket-one\/plans\/[0-9a-f-]{36}\.pdf$/)
    // switch bucket and prefix: the old file must still resolve
    await api('PUT', '/api/settings', admin, { storage: { backend: 's3', s3: { ...s3, bucket: 'bucket-two', prefix: 'other' } } })
    const got = await app.inject(`/api/documents/${created.id}/file?token=${admin}`)
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload.equals(pdf)).toBe(true)
    await api('PUT', '/api/settings', admin, { storage: { backend: 'local' } })
  })
})
