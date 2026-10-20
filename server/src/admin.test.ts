import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'
import { setTransportFactory } from './mail.js'
import { Storage, validateS3Config } from './storage.js'
import type { S3Config } from './storage.js'

const objects = new Map<string, Buffer>()
const sent: any[] = []
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

let app: Awaited<ReturnType<typeof buildApp>>
let filesDir: string
let admin = ''
const H = () => ({ authorization: `Bearer ${admin}` })
const s3Body = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'plans-bucket', region: 'auto', accessKeyId: 'AKIA', secret: 'topsecret', pathStyle: false }

beforeAll(async () => {
  const db = await openDb(undefined, null)
  await migrate(db)
  filesDir = mkdtempSync(path.join(tmpdir(), 'pm-admin-'))
  app = await buildApp({ db, jwtSecret: 'test', filesDir, s3Factory: fakeS3 })
  admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'boss@x.com', name: 'Boss', password: 'password1' } })).json().token
})

const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })
const tokenOf = (link: string) => link.split('/').pop()!

describe('settings', () => {
  it('is admin only and masks secrets', async () => {
    const user = (await app.inject({ method: 'POST', url: '/api/users', headers: H(), payload: { email: 'u@x.com', name: 'U', password: 'password1' } })).json()
    expect(user.id).toBeTruthy()
    const ut = (await login('u@x.com', 'password1')).json().token
    expect((await app.inject({ url: '/api/settings', headers: { authorization: `Bearer ${ut}` } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization: `Bearer ${ut}` }, payload: { tags: { padding: 3 } } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/company', headers: { authorization: `Bearer ${ut}` } })).statusCode).toBe(200)

    const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: {
      company: { name: 'Acme Security', address: '1 Main St', phone: '555' },
      smtp: { host: 'smtp.x.com', port: 587, from: 'noreply@x.com', user: 'u', pass: 'smtp-pass' },
      storage: { backend: 'local', s3: s3Body },
    } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.company.name).toBe('Acme Security')
    expect(body.storage.s3.secret).toBeUndefined()
    expect(body.storage.s3.secret_set).toBe(true)
    expect(body.smtp.pass).toBeUndefined()
    expect(body.smtp.pass_set).toBe(true)
    expect(JSON.stringify((await app.inject({ url: '/api/settings', headers: H() })).json())).not.toContain('topsecret')
    expect(JSON.stringify((await app.inject({ url: '/api/company', headers: H() })).json())).not.toContain('topsecret')
    // a blank secret keeps the stored one
    await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { storage: { s3: { secret: '' , bucket: 'plans-bucket' } } } })
    const again = (await app.inject({ url: '/api/settings', headers: H() })).json()
    expect(again.storage.s3.secret_set).toBe(true)
  })

  it('rejects bad values', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { tags: { padding: 7 } } })).statusCode).toBe(400)
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { storage: { backend: 's3', s3: { bucket: 'X' } } } })
    expect(bad.statusCode).toBe(400)
    expect((await app.inject({ url: '/api/settings', headers: H() })).json().storage.backend).toBe('local')
  })

  it('pads new tags with the configured number of digits', async () => {
    const [set] = (await app.inject({ url: '/api/symbol-sets', headers: H() })).json()
    const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: H(), payload: { name: 'Tags' } })).json().id
    const pdf = await makePdf(1)
    const mp = Buffer.concat([
      Buffer.from('--XX\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n'), pdf, Buffer.from('\r\n--XX--\r\n')])
    const doc = (await app.inject({ method: 'POST', url: `/api/projects/${project}/documents`,
      headers: { ...H(), 'content-type': 'multipart/form-data; boundary=XX' }, payload: mp })).json().id
    const put = async (id: string) => (await app.inject({ method: 'PUT', url: `/api/documents/${doc}/markups/${id}`, headers: H(),
      payload: { type: 'point', page: 1, geometry: { x: 1, y: 1 }, symbol_set_id: set.id } })).json().tag
    const p = set.tag_prefix
    expect(await put('00000000-0000-4000-8000-000000000001')).toBe(`${p}-01`)
    await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { tags: { padding: 3 } } })
    expect(await put('00000000-0000-4000-8000-000000000002')).toBe(`${p}-002`)
    await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { tags: { padding: 2 } } })
  })

  it('stores and serves a PNG logo, rejecting other types', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const part = (type: string) => Buffer.concat([
      Buffer.from(`--LL\r\nContent-Disposition: form-data; name="file"; filename="l"\r\nContent-Type: ${type}\r\n\r\n`), png, Buffer.from('\r\n--LL--\r\n')])
    const h = { ...H(), 'content-type': 'multipart/form-data; boundary=LL' }
    expect((await app.inject({ method: 'POST', url: '/api/settings/logo', headers: h, payload: part('text/html') })).statusCode).toBe(400)
    const ok = await app.inject({ method: 'POST', url: '/api/settings/logo', headers: h, payload: part('image/png') })
    expect(ok.json().has_logo).toBe(true)
    const got = await app.inject({ url: `/api/company/logo?token=${admin}` })
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.rawPayload.equals(png)).toBe(true)
  })
})

describe('invites and resets', () => {
  let projectId = ''
  it('creates an invite that can be accepted once', async () => {
    projectId = (await app.inject({ method: 'POST', url: '/api/projects', headers: H(), payload: { name: 'Inv' } })).json().id
    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { ...H(), origin: 'https://pm.example.com' },
      payload: { email: 'New@x.com', role: 'user', projects: [{ id: projectId, role: 'editor' }] } })
    expect(res.statusCode).toBe(200)
    const inv = res.json()
    expect(inv.link).toMatch(/^https:\/\/pm\.example\.com\/invite\/[A-Za-z0-9_-]{43}$/)
    expect(inv.emailed).toBe(false)
    const list = (await app.inject({ url: '/api/users', headers: H() })).json()
    expect(list.find((u: any) => u.email === 'new@x.com')).toMatchObject({ status: 'invited', project_count: 1 })
    expect((await login('new@x.com', '!')).statusCode).toBe(401)

    const t = tokenOf(inv.link)
    const info = (await app.inject(`/api/invites/${t}`)).json()
    expect(info).toMatchObject({ email: 'new@x.com', inviter: 'Boss', company: 'Acme Security' })
    expect((await app.inject({ method: 'POST', url: `/api/invites/${t}/accept`, payload: { name: 'Nia', password: 'short' } })).statusCode).toBe(400)
    const acc = await app.inject({ method: 'POST', url: `/api/invites/${t}/accept`, payload: { name: 'Nia', password: 'password1' } })
    expect(acc.statusCode).toBe(200)
    expect(acc.json().user.name).toBe('Nia')
    expect((await app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${acc.json().token}` } })).json()).toHaveLength(1)
    expect((await login('new@x.com', 'password1')).statusCode).toBe(200)
    expect((await app.inject(`/api/invites/${t}`)).statusCode).toBe(410)
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers: H(), payload: { email: 'new@x.com', role: 'user' } })).statusCode).toBe(409)
  })

  it('expires, resends and revokes', async () => {
    const inv = (await app.inject({ method: 'POST', url: '/api/invites', headers: H(), payload: { email: 'late@x.com', role: 'user' } })).json()
    const old = tokenOf(inv.link)
    // expire it
    // (a newer link replaces the older one)
    const resend = (await app.inject({ method: 'POST', url: `/api/users/${inv.user_id}/invite`, headers: H() })).json()
    expect((await app.inject(`/api/invites/${old}`)).statusCode).toBe(404) // replaced by the new link
    expect((await app.inject(`/api/invites/${tokenOf(resend.link)}`)).statusCode).toBe(200)
    const revoke = await app.inject({ method: 'DELETE', url: `/api/users/${inv.user_id}/invite`, headers: H() })
    expect(revoke.statusCode).toBe(200)
    expect((await app.inject(`/api/invites/${tokenOf(resend.link)}`)).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/users', headers: H() })).json().some((u: any) => u.email === 'late@x.com')).toBe(false)
  })

  it('treats an expired link as gone', async () => {
    const dbq = await openDb(undefined, null)
    await migrate(dbq)
    const a2 = await buildApp({ db: dbq, jwtSecret: 't', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-x-')) })
    const adm = (await a2.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'A', password: 'password1' } })).json().token
    const inv = (await a2.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${adm}` }, payload: { email: 'e@x.com', role: 'user' } })).json()
    await dbq.query("UPDATE user_tokens SET expires_at = now() - interval '1 minute'")
    const res = await a2.inject(`/api/invites/${tokenOf(inv.link)}`)
    expect(res.statusCode).toBe(410)
    expect((await a2.inject({ method: 'POST', url: `/api/invites/${tokenOf(inv.link)}/accept`, payload: { password: 'password1' } })).statusCode).toBe(410)
    await a2.close()
  })

  it('invites straight into a project and emails when SMTP is set', async () => {
    setTransportFactory(() => ({ sendMail: async o => { sent.push(o) } }))
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/invites`, headers: H(), payload: { email: 'mail@x.com', role: 'viewer' } })
    expect(res.json().emailed).toBe(true)
    expect(sent[0].to).toBe('mail@x.com')
    expect(sent[0].text).toContain(res.json().link)
    const members = (await app.inject({ url: `/api/projects/${projectId}/members`, headers: H() })).json()
    expect(members.find((m: any) => m.email === 'mail@x.com')).toMatchObject({ role: 'viewer', status: 'invited' })
  })

  it('resets a password with a link that works once', async () => {
    const [u] = (await app.inject({ url: '/api/users', headers: H() })).json().filter((x: any) => x.email === 'u@x.com')
    const r = (await app.inject({ method: 'POST', url: `/api/users/${u.id}/reset`, headers: H() })).json()
    expect(r.link).toContain('/reset/')
    const t = tokenOf(r.link)
    expect((await app.inject(`/api/invites/${t}`)).statusCode).toBe(404) // wrong purpose
    expect((await app.inject(`/api/resets/${t}`)).json().email).toBe('u@x.com')
    const acc = await app.inject({ method: 'POST', url: `/api/resets/${t}/accept`, payload: { password: 'newpassword1' } })
    expect(acc.statusCode).toBe(200)
    expect((await login('u@x.com', 'password1')).statusCode).toBe(401)
    expect((await login('u@x.com', 'newpassword1')).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/resets/${t}/accept`, payload: { password: 'another1234' } })).statusCode).toBe(410)
  })
})

describe('users', () => {
  it('deactivating blocks login and existing sessions, and reactivating restores them', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/users', headers: H(), payload: { email: 'd@x.com', name: 'Dee', password: 'password1' } })).json()
    const tok = (await login('d@x.com', 'password1')).json().token
    const ah = { authorization: `Bearer ${tok}` }
    expect((await app.inject({ url: '/api/projects', headers: ah })).statusCode).toBe(200)
    const res = await app.inject({ method: 'PATCH', url: `/api/users/${created.id}`, headers: H(), payload: { status: 'deactivated' } })
    expect(res.json().status).toBe('deactivated')
    expect((await login('d@x.com', 'password1')).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/projects', headers: ah })).statusCode).toBe(401)
    await app.inject({ method: 'PATCH', url: `/api/users/${created.id}`, headers: H(), payload: { status: 'active', name: 'Dee D', is_admin: true } })
    expect((await login('d@x.com', 'password1')).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/users/' + created.id, headers: H() })).json()).toMatchObject({ name: 'Dee D', is_admin: true })
  })

  it('protects the last admin and self', async () => {
    const me = (await app.inject({ url: '/api/me', headers: H() })).json()
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${me.id}`, headers: H(), payload: { status: 'deactivated' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${me.id}`, headers: H(), payload: { is_admin: false } })).statusCode).toBe(400)
  })

  it('tracks last_seen_at on authenticated requests', async () => {
    const u = (await app.inject({ method: 'POST', url: '/api/users', headers: H(), payload: { email: 'ls@x.com', name: 'Seen', password: 'password1' } })).json()
    const before = (await app.inject({ url: `/api/users/${u.id}`, headers: H() })).json()
    expect(before.last_seen_at).toBeNull()
    const tok = (await login('ls@x.com', 'password1')).json().token
    await app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${tok}` } })
    expect((await app.inject({ url: `/api/users/${u.id}`, headers: H() })).json().last_seen_at).not.toBeNull()
  })

  it('manages project memberships from the user drawer and the project', async () => {
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: H(), payload: { name: 'Mem' } })).json().id
    const u = (await app.inject({ url: '/api/users', headers: H() })).json().find((x: any) => x.email === 'ls@x.com')
    const set = await app.inject({ method: 'PUT', url: `/api/users/${u.id}/projects`, headers: H(), payload: { project_id: p, role: 'editor' } })
    expect(set.json().projects).toEqual([{ id: p, name: 'Mem', role: 'editor' }])
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p}/members/${u.id}`, headers: H() })).statusCode).toBe(200)
    const me = (await app.inject({ url: '/api/me', headers: H() })).json()
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p}/members/${me.id}`, headers: H() })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/projects/all', headers: H() })).json().some((x: any) => x.id === p)).toBe(true)
    const dir = (await app.inject({ url: '/api/users/directory', headers: H() })).json()
    expect(dir.some((x: any) => x.email === 'ls@x.com')).toBe(true)
  })

  it('changes your own name and password', async () => {
    const tok = (await login('ls@x.com', 'password1')).json().token
    const h = { authorization: `Bearer ${tok}` }
    expect((await app.inject({ method: 'PATCH', url: '/api/me', headers: h, payload: { name: 'New Name' } })).json().name).toBe('New Name')
    expect((await app.inject({ method: 'POST', url: '/api/me/password', headers: h, payload: { current: 'wrong', password: 'password2' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/me/password', headers: h, payload: { current: 'password1', password: 'password2' } })).statusCode).toBe(200)
    expect((await login('ls@x.com', 'password2')).statusCode).toBe(200)
  })
})

describe('storage', () => {
  const cfg: S3Config = { endpoint: 'https://x.r2.cloudflarestorage.com', bucket: 'my-bucket', region: 'auto', accessKeyId: 'a', secret: 's', pathStyle: false, prefix: '' }

  it('validates S3 settings', () => {
    expect(validateS3Config(cfg)).toBeNull()
    expect(validateS3Config({ ...cfg, bucket: 'A_B' })).toMatch(/Bucket/)
    expect(validateS3Config({ ...cfg, endpoint: 'ftp://x' })).toMatch(/Endpoint/)
    expect(validateS3Config({ ...cfg, endpoint: 'nonsense' })).toMatch(/Endpoint/)
    expect(validateS3Config({ ...cfg, secret: '' })).toMatch(/Secret/)
    expect(validateS3Config({ ...cfg, accessKeyId: '' })).toMatch(/Access key/)
    expect(validateS3Config({ ...cfg, region: '' })).toMatch(/Region/)
    expect(validateS3Config({ ...cfg, prefix: '../x' })).toMatch(/Prefix/)
    expect(validateS3Config(null)).toMatch(/missing/)
  })

  it('local storage saves, reads, sizes and removes files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-st-'))
    const st = new Storage(dir)
    const key = await st.save('pdf', Buffer.from('hello'))
    expect(key).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(await st.size(key)).toBe(5)
    expect((await st.read(key))!.toString()).toBe('hello')
    expect(readdirSync(dir)).toContain(key)
    await st.remove(key)
    expect(await st.size(key)).toBeNull()
    expect(await st.open('../../etc/passwd')).toBeNull()
  })

  it('tests the connection with a mock and reports failures', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/storage/test', headers: H(), payload: { s3: s3Body } })
    expect(ok.statusCode).toBe(200)
    expect([...objects.keys()].some(k => k.includes('planmark-test'))).toBe(false) // probe object cleaned up
    const bad = await app.inject({ method: 'POST', url: '/api/storage/test', headers: H(), payload: { s3: { ...s3Body, bucket: 'Bad_Bucket' } } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/Bucket/)
  })

  it('writes new files to S3 after switching and still reads older local files', async () => {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: H(), payload: { name: 'S3' } })).json().id
    const bytes: Record<string, Buffer> = { local: await makePdf(1, 'local'), remote: await makePdf(1, 'remote') }
    const pdf = (n: string) => Buffer.concat([
      Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${n}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      bytes[n], Buffer.from('\r\n--B--\r\n')])
    const h = { ...H(), 'content-type': 'multipart/form-data; boundary=B' }
    const local = (await app.inject({ method: 'POST', url: `/api/projects/${project}/documents`, headers: h, payload: pdf('local') })).json()
    const before = objects.size
    const sw = await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { storage: { backend: 's3', s3: s3Body } } })
    expect(sw.statusCode).toBe(200)
    const remote = (await app.inject({ method: 'POST', url: `/api/projects/${project}/documents`, headers: h, payload: pdf('remote') })).json()
    expect(objects.size).toBe(before + 1)
    expect((await app.inject(`/api/documents/${local.id}/file?token=${admin}`)).rawPayload.equals(bytes.local)).toBe(true)
    expect((await app.inject(`/api/documents/${remote.id}/file?token=${admin}`)).rawPayload.equals(bytes.remote)).toBe(true)
    const usage = (await app.inject({ url: '/api/storage/usage', headers: H() })).json()
    expect(usage.files.s3_bytes).toBeGreaterThan(0)
    expect(usage.projects.find((p: any) => p.name === 'S3').file_count).toBe(2)
    // back to local: the bucket file is still readable
    await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { storage: { backend: 'local' } } })
    expect((await app.inject(`/api/documents/${remote.id}/file?token=${admin}`)).rawPayload.equals(bytes.remote)).toBe(true)
  })

  it('previews and runs revision cleanup', async () => {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: H(), payload: { name: 'Ret' } })).json().id
    const revPdfs = await Promise.all([1, 2, 3, 4, 5].map(n => makePdf(1, `rev${n}`)))
    const body = (n: number) => Buffer.concat([
      Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="r.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      revPdfs[n - 1], Buffer.from('\r\n--B--\r\n')])
    const h = { ...H(), 'content-type': 'multipart/form-data; boundary=B' }
    const doc = (await app.inject({ method: 'POST', url: `/api/projects/${project}/documents`, headers: h, payload: body(1) })).json().id
    for (let i = 2; i <= 5; i++) await app.inject({ method: 'POST', url: `/api/documents/${doc}/revisions`, headers: h, payload: body(i) })
    expect((await app.inject({ url: '/api/storage/cleanup', headers: H() })).json().candidates).toEqual([])
    await app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { retention: { mode: 'keep', keep_latest: 2 } } })
    const prev = (await app.inject({ url: '/api/storage/cleanup', headers: H() })).json()
    expect(prev.candidates.filter((c: any) => c.document === 'r').map((c: any) => c.revision)).toEqual([1, 2, 3])
    expect(prev.reclaim_bytes).toBeGreaterThan(0)
    const ids = prev.candidates.map((c: any) => c.id)
    expect((await app.inject({ method: 'POST', url: '/api/storage/cleanup', headers: H(), payload: {} })).statusCode).toBe(400)
    const run = (await app.inject({ method: 'POST', url: '/api/storage/cleanup', headers: H(), payload: { ids } })).json()
    expect(run.removed).toBe(ids.length)
    const revs = (await app.inject({ url: `/api/documents/${doc}/revisions`, headers: H() })).json()
    expect(revs.map((r: any) => r.revision)).toEqual([5, 4])
    expect((await app.inject({ url: '/api/storage/cleanup', headers: H() })).json().candidates).toEqual([])
  })
})
