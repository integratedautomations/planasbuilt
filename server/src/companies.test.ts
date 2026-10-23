// Multiple companies on one install: isolation of projects, catalog, settings, people and backups, switching, invites,
// membership rules, per-company storage and moving a project between companies.
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Awaited<ReturnType<typeof openDb>>
let rcloneDir = ''
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

const savedEnv = { key: process.env.BACKUP_ENCRYPTION_KEY, dir: process.env.RCLONE_DIR }
const api = (method: string, url: string, token: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })
const cx = (id: string) => ({ 'x-company-id': id })
const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1' } })).json().token as string
const mp = (file: Buffer, name = 'a.pdf') => Buffer.concat([
  Buffer.from(`--SB\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`), file, Buffer.from('\r\n--SB--\r\n')])
const upload = (url: string, token: string, file: Buffer, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: mp(file), headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=SB', ...headers } })

let root = '', rootId = '', alice = '', bob = '', carol = '', dave = '', erin = ''
let c1 = '', c2 = ''
const ids: Record<string, string> = {}
/** Accepts every pending company invitation of a person (existing accounts join a company only by consent). */
const acceptAll = async (token: string) => {
  const list = (await api('GET', '/api/company-invitations', token)).json()
  for (const inv of list) expect((await api('POST', `/api/company-invitations/${inv.id}/accept`, token)).statusCode).toBe(200)
  return list
}

const mkUser = async (email: string, company: string, opts: { isAdmin?: boolean; canCreateProjects?: boolean } = {}) => {
  const r = await api('POST', '/api/users', root, { email, name: email.split('@')[0], password: 'password1', ...opts }, cx(company))
  expect(r.statusCode, r.body).toBe(200)
  ids[email.split('@')[0]] = r.json().id
  return login(email)
}
const mkSet = async (token: string, company: string, name: string, prefix: string) => {
  const r = await api('POST', '/api/symbol-sets', token, { name, tag_prefix: prefix, color: '#1971c2', icon: '', fields: [], has_fov: false }, cx(company))
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

beforeAll(async () => {
  rcloneDir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-co-')), '.rclone')
  process.env.BACKUP_ENCRYPTION_KEY = 'a-test-key-that-is-long-enough'
  process.env.RCLONE_DIR = rcloneDir
  db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-co-f-')), s3Factory: fakeS3, publicUrl: 'https://pm.example.com' })
  const setup = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'root@x.com', name: 'Root', password: 'password1', setupCode: 'test-setup-code' } })).json()
  root = setup.token; rootId = setup.user.id
  c1 = (await api('GET', '/api/companies', root)).json()[0].id
  const made = await api('POST', '/api/companies', root, { name: 'Beta Co' })
  expect(made.statusCode, made.body).toBe(201)
  c2 = made.json().id
  alice = await mkUser('alice@x.com', c1, { isAdmin: true })
  bob = await mkUser('bob@x.com', c1, { canCreateProjects: true })
  carol = await mkUser('carol@x.com', c2, { isAdmin: true })
  dave = await mkUser('dave@x.com', c1)
  erin = await mkUser('erin@x.com', c2)
  // dave works for both companies with one login
  expect((await api('PUT', `/api/companies/${c2}/members`, root, { email: 'dave@x.com', role: 'member' })).statusCode).toBe(201)
})

afterAll(async () => {
  await app.close()
  if (savedEnv.key === undefined) delete process.env.BACKUP_ENCRYPTION_KEY; else process.env.BACKUP_ENCRYPTION_KEY = savedEnv.key
  if (savedEnv.dir === undefined) delete process.env.RCLONE_DIR; else process.env.RCLONE_DIR = savedEnv.dir
})

describe('the companies API', () => {
  it('lists my companies; platform admins see all, the active one is marked', async () => {
    const mine = (await api('GET', '/api/companies', alice)).json()
    expect(mine.map((c: any) => c.id)).toEqual([c1])
    expect(mine[0]).toMatchObject({ role: 'admin', member: true, active: true })
    const dv = (await api('GET', '/api/companies', dave)).json()
    expect(dv.map((c: any) => c.id).sort()).toEqual([c1, c2].sort())
    expect(dv.find((c: any) => c.id === c1).role).toBe('member')
    const all = (await api('GET', '/api/companies', root)).json()
    expect(all.map((c: any) => c.id)).toEqual([c1, c2])
    expect((await api('GET', `/api/companies/${c2}`, alice)).statusCode).toBe(404)
    // the member count is only for admins
    expect(dv.find((c: any) => c.id === c1).member_count).toBeUndefined()
  })

  it('only a platform admin creates companies; owners/admins rename and archive their own', async () => {
    expect((await api('POST', '/api/companies', alice, { name: 'Sneaky' })).statusCode).toBe(403)
    expect((await api('POST', '/api/companies', root, { name: '  ' })).statusCode).toBe(400)
    expect((await api('PATCH', `/api/companies/${c2}`, alice, { name: 'Hijack' })).statusCode).toBe(404) // not theirs: does not exist for them
    expect((await api('PATCH', `/api/companies/${c2}`, erin, { name: 'Hijack' })).statusCode).toBe(403) // a plain member
    const renamed = await api('PATCH', `/api/companies/${c2}`, carol, { name: 'Beta Company' })
    expect(renamed.json()).toMatchObject({ name: 'Beta Company' })
    expect((await api('GET', '/api/company', carol, undefined, cx(c2))).json().name).toBe('Beta Company') // branding name follows
    expect((await api('PATCH', `/api/companies/${c2}`, carol, { name: 'Beta Co' })).statusCode).toBe(200)
    const third = await api('POST', '/api/companies', root, { name: 'Gamma Ltd', seed_catalog: true })
    expect(third.statusCode).toBe(201)
    const g = third.json().id
    expect((await api('GET', '/api/symbol-sets', root, undefined, cx(g))).json().length).toBeGreaterThan(0) // starter catalog on request
    expect((await api('PATCH', `/api/companies/${g}`, root, { archived: true })).json().archived).toBe(true)
    expect((await api('GET', '/api/companies', root)).json().some((c: any) => c.id === g)).toBe(false)
    expect((await api('GET', '/api/companies?include_archived=1', root)).json().some((c: any) => c.id === g)).toBe(true)
  })

  it('manages members: add, role, remove, never losing the last owner', async () => {
    const list = (await api('GET', `/api/companies/${c1}/members`, alice)).json()
    expect(list.map((m: any) => m.email).sort()).toEqual(['alice@x.com', 'bob@x.com', 'dave@x.com', 'root@x.com'])
    expect((await api('GET', `/api/companies/${c1}/members`, bob)).statusCode).toBe(403)
    expect((await api('GET', `/api/companies/${c2}/members`, alice)).statusCode).toBe(404)
    // an admin cannot make an owner, only an owner can
    expect((await api('PUT', `/api/companies/${c1}/members`, alice, { email: 'bob@x.com', role: 'owner' })).statusCode).toBe(403)
    expect((await api('PATCH', `/api/companies/${c1}/members/${ids.bob}`, alice, { role: 'guest' })).json()).toMatchObject({ role: 'guest' })
    expect((await api('PATCH', `/api/companies/${c1}/members/${ids.bob}`, alice, { role: 'member', can_create_projects: true })).json()).toMatchObject({ role: 'member', can_create_projects: true })
    expect((await api('PATCH', `/api/companies/${c1}/members/${ids.bob}`, alice, { role: 'wizard' })).statusCode).toBe(400)
    // the only owner of c1 is root: nobody can remove or demote them
    expect((await api('DELETE', `/api/companies/${c1}/members/${rootId}`, alice)).statusCode).toBe(403)
    expect((await api('DELETE', `/api/companies/${c1}/members/${rootId}`, root)).statusCode).toBe(400)
    expect((await api('PATCH', `/api/companies/${c1}/members/${rootId}`, root, { role: 'admin' })).statusCode).toBe(400)
    // unknown people are invited, not added
    expect((await api('PUT', `/api/companies/${c1}/members`, alice, { email: 'nobody@x.com' })).statusCode).toBe(404)
  })
})

describe('catalog and settings isolation', () => {
  let set1: any, set2: any
  beforeAll(async () => {
    set1 = await mkSet(alice, c1, 'Alpha Cams', 'ACM')
    set2 = await mkSet(carol, c2, 'Beta Locks', 'BLK')
  })

  it('each company lists only its own symbol sets and catalog', async () => {
    const a = (await api('GET', '/api/symbol-sets', alice)).json()
    expect(a.some((s: any) => s.id === set1.id)).toBe(true)
    expect(a.some((s: any) => s.id === set2.id)).toBe(false)
    const c = (await api('GET', '/api/symbol-sets', carol)).json()
    expect(c.map((s: any) => s.id)).toEqual([set2.id])
    const cat2 = (await api('GET', '/api/catalog', carol)).json()
    expect(cat2.device_types).toEqual([])
    expect(cat2.products).toEqual([])
    const cat1 = (await api('GET', '/api/catalog', alice)).json()
    expect(cat1.device_types.length).toBeGreaterThan(0) // the starter catalog lives in the first company
  })

  it('cannot read or change another company\'s sets, types, products, cable types or mappings (404, not 403)', async () => {
    const dt2 = (await api('POST', `/api/symbol-sets/${set2.id}/device-types`, carol, { name: 'Strike', icon: '' })).json()
    const pr2 = (await api('POST', '/api/products', carol, { device_type_id: dt2.id, manufacturer: 'HES', model: '9600', name: 'Strike', unit_cost: 120, labor_hours: 1 })).json()
    const cb2 = (await api('POST', '/api/cable-types', carol, { name: 'Beta Cable', color: '#2f9e44' })).json()
    expect(pr2.id).toBeTruthy()
    const body = { name: 'X', tag_prefix: 'X', color: '#000000', icon: '', fields: [], has_fov: false }
    expect((await api('PUT', `/api/symbol-sets/${set2.id}`, alice, body)).statusCode).toBe(404)
    expect((await api('DELETE', `/api/symbol-sets/${set2.id}`, alice)).statusCode).toBe(404)
    expect((await api('POST', `/api/symbol-sets/${set2.id}/device-types`, alice, { name: 'Evil', icon: '' })).statusCode).toBe(404)
    expect((await api('PUT', `/api/symbol-sets/${set2.id}/device-types/order`, alice, { ids: [dt2.id] })).statusCode).toBe(404)
    expect((await api('PUT', `/api/device-types/${dt2.id}`, alice, { name: 'Evil', icon: '' })).statusCode).toBe(404)
    expect((await api('DELETE', `/api/device-types/${dt2.id}`, alice)).statusCode).toBe(404)
    expect((await api('PUT', `/api/products/${pr2.id}`, alice, { manufacturer: 'Evil', model: '1' })).statusCode).toBe(404)
    expect((await api('DELETE', `/api/products/${pr2.id}`, alice)).statusCode).toBe(404)
    expect((await api('PUT', `/api/cable-types/${cb2.id}`, alice, { name: 'Evil', color: '#000000' })).statusCode).toBe(404)
    expect((await api('DELETE', `/api/cable-types/${cb2.id}`, alice)).statusCode).toBe(404)
    // building on another company's rows is refused
    expect((await api('POST', '/api/products', alice, { device_type_id: dt2.id, manufacturer: 'A', model: 'B', name: 'C' })).statusCode).toBe(400)
    const map = (extra: any) => api('PUT', '/api/revu-mappings', alice, { mappings: [{ signature: 'sig', action: 'device', symbol_set_id: set1.id, ...extra }] })
    expect((await map({ symbol_set_id: set2.id })).statusCode).toBe(400)
    expect((await map({ device_type_id: dt2.id })).statusCode).toBe(400)
    expect((await map({ product_id: pr2.id })).statusCode).toBe(400)
    // untouched
    expect((await api('GET', '/api/catalog', carol)).json().products.find((p: any) => p.id === pr2.id)).toMatchObject({ manufacturer: 'HES' })
    // accessories cannot point into another company either
    const mine = (await api('GET', '/api/catalog', alice)).json().device_types[0]
    const withAcc = await api('POST', '/api/products', alice, { device_type_id: mine.id, manufacturer: 'M', model: 'W', name: 'W', accessories: [{ product_id: pr2.id, qty: 1 }, { name: 'Loose', qty: 2 }] })
    expect(withAcc.json().accessories).toEqual([{ name: 'Loose', unit_cost: 0, labor_hours: 0, qty: 2 }])
  })

  it('revu mappings are per company', async () => {
    const put = await api('PUT', '/api/revu-mappings', alice, { mappings: [{ signature: 'shared-sig', action: 'device', symbol_set_id: set1.id }] })
    expect(put.statusCode).toBe(200)
    expect((await api('PUT', '/api/revu-mappings', carol, { mappings: [{ signature: 'shared-sig', action: 'skip' }] })).statusCode).toBe(200)
    expect((await api('GET', '/api/revu-mappings', alice)).json().find((m: any) => m.signature === 'shared-sig')).toMatchObject({ action: 'device', symbol_set_id: set1.id })
    expect((await api('GET', '/api/revu-mappings', carol)).json()).toMatchObject([{ signature: 'shared-sig', action: 'skip' }])
  })

  it('the standard library installs into the active company only', async () => {
    const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM symbol_sets WHERE company_id = $1', [c1]))[0].n
    const run = await api('POST', '/api/catalog/standard-library', carol)
    expect(run.json().setsCreated).toBeGreaterThan(0)
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM symbol_sets WHERE company_id = $1', [c1]))[0].n).toBe(before)
    expect((await api('GET', '/api/catalog/standard-library', carol)).json()).toMatchObject({ setsCreated: 0 }) // second run: nothing to do
    expect((await api('POST', '/api/catalog/standard-library', erin)).statusCode).toBe(403)
  })

  it('settings are per company: separate branding, tag rules and secrets', async () => {
    expect((await api('PUT', '/api/settings', alice, { company: { name: 'Acme Security' }, tags: { padding: 3 } })).statusCode).toBe(200)
    expect((await api('PUT', '/api/settings', carol, { company: { name: 'Beta Security' }, tags: { padding: 4 }, smtp: { host: 'smtp.beta.test', port: 587, from: 'x@beta.test', pass: 'beta-secret' } })).statusCode).toBe(200)
    const s1 = (await api('GET', '/api/settings', alice)).json(), s2 = (await api('GET', '/api/settings', carol)).json()
    expect(s1.company.name).toBe('Acme Security'); expect(s2.company.name).toBe('Beta Security')
    expect(s1.tags.padding).toBe(3); expect(s2.tags.padding).toBe(4)
    expect(s1.smtp.host).toBe(''); expect(s2.smtp.host).toBe('smtp.beta.test')
    expect(JSON.stringify(s1)).not.toContain('beta-secret')
    // the company list follows the branding name
    expect((await api('GET', '/api/companies', alice)).json()[0].name).toBe('Acme Security')
    // /api/company (public to members) is the active company's
    expect((await api('GET', '/api/company', erin)).json()).toMatchObject({ name: 'Beta Security', tag_padding: 4 })
    // an admin of one company cannot reach the other's settings, even by naming it
    expect((await api('GET', '/api/settings', alice, undefined, cx(c2))).statusCode).toBe(403)
    expect((await api('PUT', '/api/settings', alice, { tags: { padding: 2 } }, cx(c2))).statusCode).toBe(403)
    expect((await api('GET', '/api/settings', erin)).statusCode).toBe(403) // a plain member is not an admin
    expect((await api('GET', '/api/settings', dave, undefined, cx(c2))).statusCode).toBe(403) // dave is a member of both, admin of neither
  })

  it('each company has its own backup targets; the shared config tags them by company', async () => {
    const t = { type: 'sftp', name: 'Beta NAS', path: 'beta', config: { host: 'nas', user: 'bob' }, secrets: { pass: 'pw' } }
    const made = await api('POST', '/api/admin/backups/targets', carol, t)
    expect(made.statusCode, made.body).toBe(201)
    const a = await api('POST', '/api/admin/backups/targets', alice, { ...t, name: 'Acme NAS', path: 'acme' })
    expect(a.statusCode, a.body).toBe(201)
    expect((await api('GET', '/api/admin/backups', alice)).json().targets.map((x: any) => x.name)).toEqual(['Acme NAS'])
    expect((await api('GET', '/api/admin/backups', carol)).json().targets.map((x: any) => x.name)).toEqual(['Beta NAS'])
    expect((await api('PUT', `/api/admin/backups/targets/${made.json().id}`, alice, { name: 'Hacked' })).statusCode).toBe(404)
    expect((await api('DELETE', `/api/admin/backups/targets/${made.json().id}`, alice)).statusCode).toBe(404)
    expect((await api('POST', `/api/admin/backups/targets/${made.json().id}/test`, alice)).statusCode).toBe(404)
    expect((await api('GET', '/api/admin/backups', erin)).statusCode).toBe(403)
    expect((await api('GET', '/api/admin/backups', alice, undefined, cx(c2))).statusCode).toBe(403)
    const list = JSON.parse(readFileSync(path.join(rcloneDir, 'targets.json'), 'utf8'))
    expect(list.map((x: any) => [x.name, x.company_id]).sort()).toEqual([['Acme NAS', c1], ['Beta NAS', c2]])
    // deleting in one company leaves the other's target in the shared config
    expect((await api('DELETE', `/api/admin/backups/targets/${made.json().id}`, carol)).statusCode).toBe(200)
    expect(JSON.parse(readFileSync(path.join(rcloneDir, 'targets.json'), 'utf8')).map((x: any) => x.name)).toEqual(['Acme NAS'])
  })

  it('the company export holds only that company\'s rows, never secrets', async () => {
    expect((await api('GET', `/api/admin/companies/${c2}/export`, alice)).statusCode).toBe(404)
    expect((await api('GET', `/api/admin/companies/${c2}/export`, erin)).statusCode).toBe(403)
    const ex = (await api('GET', `/api/admin/companies/${c2}/export`, carol)).json()
    expect(ex.company.id).toBe(c2)
    expect(ex.symbol_sets.every((s: any) => s.company_id === c2)).toBe(true)
    expect(ex.members.map((m: any) => m.email).sort()).toEqual(['carol@x.com', 'dave@x.com', 'erin@x.com', 'root@x.com'])
    expect(ex.members[0].password_hash).toBeUndefined()
    expect(JSON.stringify(ex)).not.toContain('beta-secret')
    expect(ex.settings.company.name).toBe('Beta Security')
  })
})

describe('projects and people', () => {
  let p1 = '', p2 = '', doc1 = '', doc2 = ''
  beforeAll(async () => {
    p1 = (await api('POST', '/api/projects', alice, { name: 'Acme HQ' })).json().id
    p2 = (await api('POST', '/api/projects', carol, { name: 'Beta Tower' })).json().id
    doc1 = (await upload(`/api/projects/${p1}/documents`, alice, await makePdf(1, 'one'))).json().id
    doc2 = (await upload(`/api/projects/${p2}/documents`, carol, await makePdf(1, 'two'))).json().id
  })

  it('a project belongs to one company and is listed only there', async () => {
    expect((await api('GET', '/api/projects', alice)).json().map((p: any) => p.id)).toEqual([p1])
    expect((await api('GET', '/api/projects', carol)).json().map((p: any) => p.id)).toEqual([p2])
    expect((await api('GET', `/api/projects/${p2}`, carol)).json()).toMatchObject({ company_id: c2 })
    // a company admin sees all of the company's projects, a member only the ones they are in
    expect((await api('GET', '/api/projects', alice)).json()[0]).toMatchObject({ role: 'admin', is_member: true })
    const bp = (await api('POST', '/api/projects', bob, { name: 'Bob\'s job' })).json().id
    expect((await api('GET', '/api/projects', alice)).json().map((p: any) => p.id).sort()).toEqual([p1, bp].sort()) // alice administers c1
    expect((await api('GET', '/api/projects', dave)).json()).toEqual([]) // dave is in no project
    expect((await api('GET', '/api/projects', dave, undefined, cx(c2))).json()).toEqual([])
    // the platform admin sees everything, in both companies
    expect((await api('GET', '/api/projects', root, undefined, cx(c2))).json().map((p: any) => p.id)).toEqual([p2])
  })

  it('every project route answers 404 for a project of a company you are not in', async () => {
    const routes: [string, string, any?][] = [
      ['GET', `/api/projects/${p2}`], ['PATCH', `/api/projects/${p2}`, { status: 'completed' }], ['GET', `/api/projects/${p2}/members`],
      ['GET', `/api/projects/${p2}/documents`], ['GET', `/api/projects/${p2}/layers`], ['GET', `/api/projects/${p2}/markups`],
      ['GET', `/api/projects/${p2}/scales`], ['GET', `/api/projects/${p2}/settings`], ['PUT', `/api/projects/${p2}/settings`, { tag_fill_gaps: true }],
      ['GET', `/api/documents/${doc2}`], ['GET', `/api/documents/${doc2}/file`], ['GET', `/api/documents/${doc2}/markups`],
      ['GET', `/api/documents/${doc2}/revisions`], ['DELETE', `/api/documents/${doc2}`], ['PATCH', `/api/documents/${doc2}`, { name: 'x' }],
      ['POST', `/api/projects/${p2}/invites`, { email: 'z@x.com' }], ['PUT', `/api/projects/${p2}/members`, { email: 'alice@x.com', role: 'viewer' }],
    ]
    for (const [m, url, body] of routes) {
      const r = await api(m, url, alice, body)
      expect(r.statusCode, `${m} ${url}`).toBe(404)
    }
    // ...even with the owning company named in the header
    expect((await api('GET', `/api/projects/${p2}`, alice, undefined, cx(c2))).statusCode).toBe(404)
    expect((await api('POST', '/api/projects', alice, { name: 'In Beta' }, cx(c2))).statusCode).toBe(403)
    // nothing was changed
    expect((await api('GET', `/api/projects/${p2}`, carol)).json()).toMatchObject({ name: 'Beta Tower', status: 'open' })
    expect((await api('GET', `/api/documents/${doc2}/file?ft=${(await api('POST', '/api/file-token', alice)).json().ft}`, '')).statusCode).toBe(404)
  })

  it('markups only reference the project\'s own company catalog', async () => {
    const mid = '33333333-3333-4333-8333-333333333333'
    const set1 = (await api('GET', '/api/symbol-sets', alice)).json().find((s: any) => s.name === 'Alpha Cams')
    const set2 = (await api('GET', '/api/symbol-sets', carol)).json().find((s: any) => s.name === 'Beta Locks')
    const put = (token: string, doc: string, set: string) =>
      api('PUT', `/api/documents/${doc}/markups/${mid}`, token, { type: 'device', page: 1, geometry: { x: 1, y: 1 }, symbol_set_id: set })
    expect((await put(alice, doc1, set2.id)).statusCode).toBe(400) // c2's set in a c1 plan
    expect((await put(carol, doc2, set1.id)).statusCode).toBe(400)
    expect((await put(alice, doc1, set1.id)).statusCode).toBe(200)
    expect((await api('DELETE', `/api/documents/${doc1}/markups/${mid}`, alice)).statusCode).toBe(200)
  })

  it('the people lists and pickers are scoped to the company', async () => {
    const u1 = (await api('GET', '/api/users', alice)).json().map((u: any) => u.email).sort()
    const u2 = (await api('GET', '/api/users', carol)).json().map((u: any) => u.email).sort()
    expect(u1).toEqual(['alice@x.com', 'bob@x.com', 'dave@x.com', 'root@x.com'])
    expect(u2).toEqual(['carol@x.com', 'dave@x.com', 'erin@x.com', 'root@x.com'])
    expect((await api('GET', '/api/users/directory', alice)).json().map((u: any) => u.email).sort()).toEqual(u1)
    expect((await api('GET', '/api/users/directory', erin)).json().map((u: any) => u.email).sort()).toEqual(u2)
    expect((await api('GET', '/api/users', erin)).statusCode).toBe(403)
    expect((await api('GET', '/api/projects/all', alice)).json().some((p: any) => p.id === p2)).toBe(false)
    // another company's person does not exist for you
    expect((await api('GET', `/api/users/${ids.carol}`, alice)).statusCode).toBe(404)
    expect((await api('PATCH', `/api/users/${ids.carol}`, alice, { name: 'x' })).statusCode).toBe(404)
    expect((await api('POST', `/api/users/${ids.carol}/reset`, alice)).statusCode).toBe(404)
    expect((await api('PUT', `/api/users/${ids.carol}/projects`, alice, { project_id: p1, role: 'viewer' })).statusCode).toBe(404)
    // ...and a project of another company cannot be assigned
    expect((await api('PUT', `/api/users/${ids.bob}/projects`, alice, { project_id: p2, role: 'viewer' })).statusCode).toBe(400)
    // the project picker (add by email) only finds people of the project's company
    expect((await api('PUT', `/api/projects/${p1}/members`, alice, { email: 'carol@x.com', role: 'viewer' })).statusCode).toBe(404)
    expect((await api('PUT', `/api/projects/${p1}/members`, alice, { email: 'dave@x.com', role: 'viewer' })).statusCode).toBe(200)
    expect((await api('GET', `/api/projects/${p1}`, dave)).statusCode).toBe(200)
  })

  it('a person shared with another company can only be managed there, not locked out of it', async () => {
    expect((await api('PATCH', `/api/users/${ids.dave}`, alice, { status: 'deactivated' })).statusCode).toBe(403)
    expect((await api('PATCH', `/api/users/${ids.dave}`, alice, { name: 'Dave Renamed' })).statusCode).toBe(403)
    expect((await api('POST', `/api/users/${ids.dave}/reset`, alice)).statusCode).toBe(403)
    // company-level things are fine: role and can_create_projects only touch this company
    expect((await api('PATCH', `/api/users/${ids.dave}`, alice, { can_create_projects: true })).json()).toMatchObject({ can_create_projects: true })
    expect((await api('GET', '/api/users', carol)).json().find((u: any) => u.email === 'dave@x.com').can_create_projects).toBe(false)
    // a platform admin can
    expect((await api('PATCH', `/api/users/${ids.dave}`, root, { name: 'Dave D' }, cx(c1))).json().name).toBe('Dave D')
    // nobody but a platform admin makes platform admins
    expect((await api('PATCH', `/api/users/${ids.bob}`, alice, { platform_admin: true })).statusCode).toBe(403)
    expect((await api('POST', '/api/users', alice, { email: 'x1@x.com', name: 'X', password: 'password1', platformAdmin: true })).json().platform_admin).toBe(false)
  })

  it('switching company: one login, the right data in each', async () => {
    const mark = (await api('POST', '/api/projects', root, { name: 'Dave job beta' }, cx(c2))).json().id
    await api('PUT', `/api/users/${ids.dave}/projects`, root, { project_id: mark, role: 'viewer' }, cx(c2))
    expect((await api('GET', '/api/projects', dave, undefined, cx(c2))).json().map((p: any) => p.id)).toEqual([mark])
    expect((await api('GET', '/api/projects', dave, undefined, cx(c1))).json().map((p: any) => p.id)).toEqual([p1])
    const names = async (c: string) => (await api('GET', '/api/symbol-sets', dave, undefined, cx(c))).json().map((s: any) => s.name)
    expect(await names(c1)).toContain('Alpha Cams')
    expect(await names(c1)).not.toContain('Beta Locks')
    expect(await names(c2)).toContain('Beta Locks')
    expect(await names(c2)).not.toContain('Alpha Cams')
    // the last company used becomes the default when no header is sent
    await api('GET', '/api/projects', dave, undefined, cx(c2))
    expect((await api('GET', '/api/me', dave)).json().company).toMatchObject({ id: c2 })
    expect((await api('GET', '/api/projects', dave)).json().map((p: any) => p.id)).toEqual([mark])
    await api('GET', '/api/projects', dave, undefined, cx(c1))
    expect((await api('GET', '/api/me', dave)).json().company).toMatchObject({ id: c1 })
    expect((await db.query<any>('SELECT last_company_id FROM user_prefs WHERE user_id = $1', [ids.dave]))[0].last_company_id).toBe(c1)
    // a company you are not in cannot be selected
    expect((await api('GET', '/api/projects', alice, undefined, cx(c2))).statusCode).toBe(403)
    expect((await api('GET', '/api/projects', alice, undefined, { 'x-company-id': 'garbage' })).statusCode).toBe(403)
    // plain image URLs name the company in the query
    const ft = (await api('POST', '/api/file-token', dave)).json().ft
    expect((await app.inject(`/api/company/logo?ft=${ft}&company=${c2}`)).statusCode).toBe(404) // no logo, but allowed
    expect((await app.inject(`/api/company/logo?ft=${(await api('POST', '/api/file-token', alice)).json().ft}&company=${c2}`)).statusCode).toBe(403)
  })

  it('what you see in the catalog follows your standing in that company', async () => {
    // bob: member of c1 with no project → no costs; as project viewer → costs; erin (member of c2) no project → none
    const costs = async (t: string, c?: string) => (await api('GET', '/api/catalog', t, undefined, c ? cx(c) : {})).json().can_see_costs
    expect(await costs(erin)).toBe(false)
    expect(await costs(alice)).toBe(true)
    // dave is a viewer in a c2 project (costs yes) but a viewer of p1 in c1 too: set one role to client to tell them apart
    await api('PUT', `/api/projects/${p1}/members`, alice, { email: 'dave@x.com', role: 'client' })
    expect(await costs(dave, c1)).toBe(false) // client in c1
    expect(await costs(dave, c2)).toBe(true) // viewer in c2
    // a guest never sees costs, whatever the projects say
    await api('PUT', `/api/companies/${c2}/members`, carol, { email: 'erin@x.com', role: 'guest' })
    const pe = (await api('POST', '/api/projects', carol, { name: 'Erin viewer' })).json().id
    await api('PUT', `/api/projects/${pe}/members`, carol, { email: 'erin@x.com', role: 'pm' })
    expect(await costs(erin)).toBe(false)
    await api('PATCH', `/api/companies/${c2}/members/${ids.erin}`, carol, { role: 'member' })
    expect(await costs(erin)).toBe(true) // pm of a c2 project
  })

  it('removing someone from a company ends their access there and nowhere else', async () => {
    const t = (await api('POST', '/api/projects', carol, { name: 'Leaver test' })).json().id
    await api('PUT', `/api/projects/${t}/members`, carol, { email: 'dave@x.com', role: 'editor' })
    expect((await api('GET', `/api/projects/${t}`, dave)).statusCode).toBe(200)
    expect((await api('DELETE', `/api/companies/${c2}/members/${ids.dave}`, carol)).json()).toEqual({ ok: true })
    expect((await api('GET', `/api/projects/${t}`, dave)).statusCode).toBe(404)
    expect((await api('GET', '/api/projects', dave, undefined, cx(c2))).statusCode).toBe(403)
    expect((await db.query('SELECT 1 FROM project_members WHERE user_id = $1 AND project_id = $2', [ids.dave, t])).length).toBe(0)
    expect((await api('GET', `/api/projects/${p1}`, dave)).statusCode).toBe(200) // still in c1
    expect((await api('GET', '/api/companies', dave)).json().map((c: any) => c.id)).toEqual([c1])
    // back in as a plain member for the rest
    const again = await api('PUT', `/api/companies/${c2}/members`, carol, { email: 'dave@x.com', role: 'member' })
    expect(again.statusCode).toBe(202) // a company admin only invites: dave joins when he accepts
    expect((await api('GET', '/api/companies', dave)).json().map((c: any) => c.id)).toEqual([c1])
    expect((await acceptAll(dave)).length).toBe(1)
    expect((await api('GET', '/api/companies', dave)).json().map((c: any) => c.id).sort()).toEqual([c1, c2].sort())
  })

  it('an archived company is closed to its members but still open to platform admins', async () => {
    const z = (await api('POST', '/api/companies', root, { name: 'Zeta Archive' })).json().id
    await api('PUT', `/api/companies/${z}/members`, root, { email: 'erin@x.com', role: 'member' })
    expect((await api('GET', '/api/symbol-sets', erin, undefined, cx(z))).statusCode).toBe(200)
    await api('PATCH', `/api/companies/${z}`, root, { archived: true })
    expect((await api('GET', '/api/symbol-sets', erin, undefined, cx(z))).statusCode).toBe(403)
    expect((await api('GET', '/api/symbol-sets', root, undefined, cx(z))).statusCode).toBe(200)
    await api('PATCH', `/api/companies/${z}`, root, { archived: false })
    expect((await api('GET', '/api/symbol-sets', erin, undefined, cx(z))).statusCode).toBe(200)
  })
})

describe('invites across companies', () => {
  it('inviting an email that already has an account adds a membership instead of a duplicate user', async () => {
    const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users'))[0].n
    const r = await api('POST', '/api/invites', carol, { email: 'alice@x.com', role: 'user' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ pending_consent: true, added_to_company: false, link: null })
    // no membership until alice accepts
    expect((await api('GET', '/api/companies', alice)).json().map((c: any) => c.id)).toEqual([c1])
    expect((await api('GET', '/api/symbol-sets', alice, undefined, cx(c2))).statusCode).toBe(403)
    const offered = (await api('GET', '/api/company-invitations', alice)).json()
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ company: { id: c2 }, role: 'member' })
    await acceptAll(alice)
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users'))[0].n).toBe(before)
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE email = 'alice@x.com'"))[0].n).toBe(1)
    expect((await api('GET', '/api/companies', alice)).json().map((c: any) => c.id).sort()).toEqual([c1, c2].sort())
    expect((await api('GET', '/api/symbol-sets', alice, undefined, cx(c2))).statusCode).toBe(200)
    // already a member: refused as before
    expect((await api('POST', '/api/invites', carol, { email: 'alice@x.com', role: 'user' })).statusCode).toBe(409)
    // a project in the invite is added too, and must belong to the inviting company
    const p = (await api('POST', '/api/projects', carol, { name: 'Invite me' })).json().id
    const withP = await api('POST', '/api/invites', carol, { email: 'bob@x.com', projects: [{ id: p, role: 'editor' }] })
    expect(withP.json().pending_consent).toBe(true)
    expect((await api('GET', `/api/projects/${p}`, bob)).statusCode).toBe(404)
    const bobInv = (await api('GET', '/api/company-invitations', bob)).json()[0]
    expect((await api('POST', `/api/company-invitations/${bobInv.id}/accept`, alice)).statusCode).toBe(404) // not alice's to accept
    expect((await api('POST', `/api/company-invitations/${bobInv.id}/accept`, bob)).statusCode).toBe(200)
    expect((await api('GET', `/api/projects/${p}`, bob, undefined, cx(c2))).json()).toMatchObject({ role: 'editor' })
    const foreign = await api('POST', '/api/invites', carol, { email: 'new1@x.com', projects: [{ id: (await api('GET', '/api/projects', alice, undefined, cx(c1))).json()[0].id, role: 'editor' }] })
    expect(foreign.statusCode).toBe(400)
  })

  it('a brand-new person joins the inviting company when they accept; a second company\'s invite adds a second membership', async () => {
    const inv = (await api('POST', '/api/invites', alice, { email: 'newbie@x.com', name: 'Newbie' }, cx(c1))).json()
    expect(inv.link).toMatch(/^https:\/\/pm\.example\.com\/invite\//)
    const token = inv.link.split('/').pop()
    expect((await app.inject(`/api/invites/${token}`)).json()).toMatchObject({ company: expect.stringContaining('Acme') })
    // another company's admin invites the same (still pending) email: refused, with no side effects (not added, no link)
    const second = await api('POST', '/api/invites', carol, { email: 'newbie@x.com' })
    expect(second.statusCode).toBe(409)
    expect(second.json().link).toBeUndefined()
    expect((await db.query('SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2', [c2, inv.user_id])).length).toBe(0)
    expect((await app.inject(`/api/invites/${token}`)).statusCode).toBe(200) // the first link still works
    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'password1', name: 'Newbie N' } })
    expect(accepted.statusCode, accepted.body).toBe(200)
    const nb = accepted.json().token
    expect((await api('GET', '/api/companies', nb)).json().map((c: any) => c.id)).toEqual([c1])
    // once active, the other company can invite them like anyone with an account: an invitation to accept
    expect((await api('POST', '/api/invites', carol, { email: 'newbie@x.com' })).json()).toMatchObject({ pending_consent: true })
    await acceptAll(nb)
    expect((await api('GET', '/api/companies', nb)).json().map((c: any) => c.id).sort()).toEqual([c1, c2].sort())
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE email = 'newbie@x.com'"))[0].n).toBe(1)
  })

  it('revoking a pending invite removes the pending account; another company can neither resend nor revoke it', async () => {
    const inv = (await api('POST', '/api/invites', alice, { email: 'pending2@x.com' }, cx(c1))).json()
    expect((await api('POST', '/api/invites', carol, { email: 'pending2@x.com' })).statusCode).toBe(409)
    expect((await api('POST', `/api/users/${inv.user_id}/invite`, carol)).statusCode).toBe(404)
    expect((await api('DELETE', `/api/users/${inv.user_id}/invite`, carol)).statusCode).toBe(404)
    expect((await api('DELETE', `/api/users/${inv.user_id}/invite`, alice, undefined, cx(c1))).json()).toEqual({ ok: true })
    expect((await db.query('SELECT 1 FROM users WHERE id = $1', [inv.user_id])).length).toBe(0)
  })
})

describe('storage follows the company', () => {
  it('a company on S3 writes there while another stays on local disk', async () => {
    const s3 = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'beta-bucket', region: 'auto', accessKeyId: 'AKIA', secret: 'topsecret', pathStyle: false }
    expect((await api('PUT', '/api/settings', carol, { storage: { backend: 's3', s3 } })).statusCode).toBe(200)
    const pc2 = (await api('POST', '/api/projects', carol, { name: 'On S3' })).json().id
    const pc1 = (await api('POST', '/api/projects', alice, { name: 'On disk' }, cx(c1))).json().id
    const before = objects.size
    const d2 = (await upload(`/api/projects/${pc2}/documents`, carol, await makePdf(1, 'remote'))).json()
    expect(objects.size).toBe(before + 1)
    const d1 = (await upload(`/api/projects/${pc1}/documents`, alice, await makePdf(1, 'local'), cx(c1))).json()
    expect(objects.size).toBe(before + 1)
    const key = (r: string) => db.query<any>('SELECT file_key FROM document_revisions WHERE id = $1', [r]).then(x => x[0].file_key as string)
    expect(await key(d2.revision_id)).toMatch(/^s3:beta-bucket\//)
    expect(await key(d1.revision_id)).not.toMatch(/^s3:/)
    expect((await api('GET', `/api/documents/${d2.id}/file`, carol)).statusCode).toBe(200)
    // usage and cleanup only cover the company's own projects
    const usage = (await api('GET', '/api/storage/usage', carol)).json()
    expect(usage.projects.map((p: any) => p.id)).not.toContain(pc1)
    expect(usage.files.s3_bytes).toBeGreaterThan(0)
    expect((await api('GET', '/api/storage/usage', alice, undefined, cx(c1))).json().projects.map((p: any) => p.id)).not.toContain(pc2)
  })
})

describe('moving a project between companies', () => {
  let solo = '', proj = '', doc = '', srcSet = '', srcType = '', srcProd = '', srcCable = ''
  const mid = '44444444-4444-4444-8444-444444444444'
  beforeAll(async () => {
    // c1 side: a set that c2 also has (by another name case), a type and a product c2 lacks, and a cable type
    const set = await mkSet(alice, c1, 'Beta Locks', 'BLK2') // same name as c2's set: it will be matched, not copied
    srcSet = set.id
    srcType = (await api('POST', `/api/symbol-sets/${set.id}/device-types`, alice, { name: 'Maglock', icon: '', tag_prefix: 'ML' })).json().id
    srcProd = (await api('POST', '/api/products', alice, { device_type_id: srcType, manufacturer: 'Securitron', model: 'M62', name: 'Maglock 1200', unit_cost: 150, labor_hours: 2 })).json().id
    srcCable = (await api('POST', '/api/cable-types', alice, { name: 'Moved Cable', color: '#1971c2' })).json().id
    proj = (await api('POST', '/api/projects', alice, { name: 'Moving' }, cx(c1))).json().id
    await api('PUT', `/api/projects/${proj}/members`, alice, { email: 'bob@x.com', role: 'editor' })
    solo = await mkUser('solo@x.com', c1) // belongs to c1 only
    await api('PUT', `/api/projects/${proj}/members`, alice, { email: 'solo@x.com', role: 'viewer' })
    doc = (await upload(`/api/projects/${proj}/documents`, alice, await makePdf(1, 'move1'), cx(c1))).json().id
    const r = await api('PUT', `/api/documents/${doc}/markups/${mid}`, alice, {
      type: 'device', page: 1, geometry: { x: 5, y: 5 }, symbol_set_id: srcSet, device_type_id: srcType, product_id: srcProd, fields: { cable_type: srcCable } })
    expect(r.statusCode, r.body).toBe(200)
    // a second revision freezes the markups into the first one's snapshot
    expect((await upload(`/api/documents/${doc}/revisions`, alice, await makePdf(1, 'move2'))).statusCode).toBe(200)
  })

  it('is for platform admins only', async () => {
    expect((await api('POST', `/api/projects/${proj}/move`, alice, { company_id: c2 })).statusCode).toBe(403)
    expect((await api('POST', `/api/projects/${proj}/move`, carol, { company_id: c2 })).statusCode).toBe(403)
    expect((await api('POST', `/api/projects/${proj}/move`, root, { company_id: c1 })).statusCode).toBe(400) // already there
    expect((await api('POST', `/api/projects/${proj}/move`, root, { company_id: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404)
    expect((await api('POST', `/api/projects/${proj}/move`, root, {})).statusCode).toBe(400)
  })

  it('remaps the catalog by name, copies what is missing, and keeps people\'s access', async () => {
    const c2Sets = (await api('GET', '/api/symbol-sets', carol)).json()
    const betaLocks = c2Sets.find((s: any) => s.name === 'Beta Locks')
    const res = await api('POST', `/api/projects/${proj}/move`, root, { company_id: c2 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      company_id: c2, from_company_id: c1,
      symbol_sets: { matched: 1, copied: 0 }, device_types: { matched: 0, copied: 1 }, products: { matched: 0, copied: 1 }, cable_types: { matched: 0, copied: 1 },
    })
    expect(res.json().members_added).toBe(1) // solo was in c1 only; alice and bob already belong to c2
    // the project and its markup now live on c2's catalog rows
    const [m] = await db.query<any>('SELECT symbol_set_id, device_type_id, product_id, fields FROM markups WHERE id = $1', [mid])
    expect(m.symbol_set_id).toBe(betaLocks.id)
    const [dt] = await db.query<any>('SELECT company_id, symbol_set_id, name FROM device_types WHERE id = $1', [m.device_type_id])
    expect(dt).toMatchObject({ company_id: c2, symbol_set_id: betaLocks.id, name: 'Maglock' })
    const [pr] = await db.query<any>('SELECT company_id, device_type_id, model, unit_cost FROM products WHERE id = $1', [m.product_id])
    expect(pr).toMatchObject({ company_id: c2, device_type_id: m.device_type_id, model: 'M62' })
    expect(Number(pr.unit_cost)).toBe(150)
    const [cb] = await db.query<any>('SELECT company_id, name FROM cable_types WHERE id = $1', [m.fields.cable_type])
    expect(cb).toMatchObject({ company_id: c2, name: 'Moved Cable' })
    // the frozen first revision was remapped too
    const [snap] = await db.query<any>('SELECT markups_snapshot FROM document_revisions WHERE document_id = $1 AND markups_snapshot IS NOT NULL', [doc])
    expect(snap.markups_snapshot[0]).toMatchObject({ symbol_set_id: betaLocks.id, device_type_id: m.device_type_id, product_id: m.product_id })
    // the default product of the copied type survived the move
    expect((await db.query<any>('SELECT default_product_id FROM device_types WHERE id = $1', [m.device_type_id]))[0].default_product_id).toBe(m.product_id)
    // c1's own catalog rows are untouched
    expect((await db.query('SELECT 1 FROM products WHERE id = $1 AND company_id = $2', [srcProd, c1])).length).toBe(1)
    // the project is c2's now: c2 admins have it, c1-only people do not
    expect((await api('GET', `/api/projects/${proj}`, carol)).json()).toMatchObject({ company_id: c2 })
    expect((await api('GET', '/api/projects', alice, undefined, cx(c1))).json().some((p: any) => p.id === proj)).toBe(false)
    expect((await api('GET', `/api/projects/${proj}`, dave)).statusCode).toBe(403) // dave is in c2 now but not in this project
    expect((await api('GET', `/api/projects/${proj}`, alice)).statusCode).toBe(200) // alice is also a member of c2 and of the project
    // everyone in the project can still open it: members of other companies joined as guests
    const members = (await api('GET', `/api/projects/${proj}/members`, carol)).json()
    for (const mm of members) {
      const role = (await db.query<any>('SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2', [c2, mm.id]))[0]?.role
      expect(role, mm.email).toBeTruthy()
    }
    expect((await db.query("SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2 AND role = 'guest'", [c2, ids.solo])).length).toBe(1)
  })

  it('a person who only belonged to the old company keeps working through a guest membership', async () => {
    expect((await api('GET', `/api/projects/${proj}`, solo)).statusCode).toBe(200)
    // guests see only the projects they are in, and the catalog without costs
    expect((await api('GET', '/api/projects', solo, undefined, cx(c2))).json().map((x: any) => x.id)).toEqual([proj])
    expect((await api('GET', '/api/catalog', solo, undefined, cx(c2))).json().can_see_costs).toBe(false)
    expect((await api('GET', '/api/symbol-sets', solo, undefined, cx(c1))).statusCode).toBe(200) // still in c1 as well
  })
})
