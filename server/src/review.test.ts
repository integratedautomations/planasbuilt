// Regression tests for the multi-company / readable-storage review: invite takeover, company folders, per-company S3,
// install-wide security settings, project invites and consent, archive rights, zip limits, SSRF, relayout robustness.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { moveProject } from './projectMove.js'
import { updateRefs } from './relayout.js'
import { Storage } from './storage.js'
import { setHostResolver } from './net.js'
import { fakeS3Client, makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Awaited<ReturnType<typeof openDb>>
let filesDir = ''
const objects = new Map<string, Buffer>()
const used: string[] = []
const s3Factory = (c: { accessKeyId: string }) => {
  const inner = fakeS3Client(objects)
  return {
    async send(cmd: any) {
      used.push(c.accessKeyId)
      if (c.accessKeyId === 'AK-ERR') throw new Error('SECRET-INTERNAL-DETAIL 10.0.0.5 refused')
      return inner.send(cmd)
    },
  }
}
const savedTok = process.env.BACKUP_INTERNAL_TOKEN
const TOKEN = 'internal-token-for-the-tests-0123456789'

const api = (method: string, url: string, token: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })
const cx = (id: string) => ({ 'x-company-id': id })
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1' } })).json().token as string
const mp = (file: Buffer, name = 'a.pdf', fields: Record<string, string> = {}) => Buffer.concat([
  ...Object.entries(fields).map(([k, v]) => Buffer.from(`--SB\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
  Buffer.from(`--SB\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`), file, Buffer.from('\r\n--SB--\r\n')])
const upload = (url: string, token: string, file: Buffer, name = 'a.pdf', fields: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: mp(file, name, fields), headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=SB' } })

let root = '', cA = '', cB = '', cZ = '', adminA = '', adminB = '', memberB = ''
const ids: Record<string, string> = {}
const mkUser = async (email: string, company: string, isAdmin = false) => {
  const r = await api('POST', '/api/users', root, { email, name: email.split('@')[0], password: 'password1', isAdmin }, cx(company))
  expect(r.statusCode, r.body).toBe(200)
  ids[email.split('@')[0]] = r.json().id
  return login(email)
}
const tokenOf = (link: string) => link.split('/').pop()!

beforeAll(async () => {
  process.env.BACKUP_INTERNAL_TOKEN = TOKEN
  db = await openDb(undefined, null)
  await migrate(db)
  filesDir = mkdtempSync(path.join(tmpdir(), 'pm-rv-f-'))
  app = await buildApp({ db, jwtSecret: 'test', filesDir, s3Factory: s3Factory as any, publicUrl: 'https://pm.example.com', zipRateLimitMax: 4 })
  root = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'root@x.com', name: 'Root', password: 'password1', setupCode: 'test-setup-code' } })).json().token
  cA = (await api('GET', '/api/companies', root)).json()[0].id
  expect((await api('PATCH', `/api/companies/${cA}`, root, { name: 'Acme' })).statusCode).toBe(200)
  // a second company whose name differs from the first only by case
  const made = await api('POST', '/api/companies', root, { name: 'ACME' })
  expect(made.statusCode, made.body).toBe(201)
  cB = made.json().id
  // a company for hand-made rows whose files do not exist (never moved by the tests above)
  cZ = (await db.query<{ id: string }>("INSERT INTO companies (name, slug, folder) VALUES ('Fixture','fixture','Fixture') RETURNING id"))[0].id
  adminA = await mkUser('adma@x.com', cA, true)
  adminB = await mkUser('admb@x.com', cB, true)
  memberB = await mkUser('memb@x.com', cB)
})

afterAll(async () => {
  await app.close()
  if (savedTok === undefined) delete process.env.BACKUP_INTERNAL_TOKEN; else process.env.BACKUP_INTERNAL_TOKEN = savedTok
})

describe('1. a pending invite belongs to the company that sent it', () => {
  let victim = '', link = ''
  it('another company cannot re-issue, join, or read the link of a pending person', async () => {
    const inv = (await api('POST', '/api/invites', adminA, { email: 'victim@x.com', name: 'Victim' }, cx(cA))).json()
    victim = inv.user_id; link = inv.link
    for (let i = 0; i < 2; i++) {
      const r = await api('POST', '/api/invites', adminB, { email: 'victim@x.com' }, cx(cB))
      expect(r.statusCode, r.body).toBe(409)
      expect(JSON.stringify(r.json())).not.toContain('/invite/')
    }
    // no side effects: B did not get a membership, the original link is untouched (no new token was minted)
    expect(await db.query('SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2', [cB, victim])).toHaveLength(0)
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM user_tokens WHERE user_id = $1 AND purpose = 'invite'", [victim]))[0].n).toBe(1)
    expect((await app.inject(`/api/invites/${tokenOf(link)}`)).statusCode).toBe(200)
  })

  it('the resend, revoke and members endpoints refuse too; the inviting company still can resend', async () => {
    expect((await api('POST', `/api/users/${victim}/invite`, adminB, undefined, cx(cB))).statusCode).toBe(404)
    expect((await api('DELETE', `/api/users/${victim}/invite`, adminB, undefined, cx(cB))).statusCode).toBe(404)
    // adding an invited person through the members endpoint is refused (even for a platform admin)
    expect((await api('PUT', `/api/companies/${cB}/members`, adminB, { email: 'victim@x.com', role: 'member' })).statusCode).toBe(409)
    expect((await api('PUT', `/api/companies/${cB}/members`, root, { user_id: victim, role: 'member' })).statusCode).toBe(409)
    expect(await db.query('SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2', [cB, victim])).toHaveLength(0)
    const again = await api('POST', `/api/users/${victim}/invite`, adminA, undefined, cx(cA))
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().link).toMatch(/\/invite\//)
    expect((await app.inject(`/api/invites/${tokenOf(link)}`)).statusCode).toBe(404) // replaced by the new link
  })
})

describe('2. every company has its own folder', () => {
  it('names that match (even apart from case) get different folders, and files go to their own', async () => {
    const [a] = await db.query<{ folder: string }>('SELECT folder FROM companies WHERE id = $1', [cA])
    const [b] = await db.query<{ folder: string }>('SELECT folder FROM companies WHERE id = $1', [cB])
    expect(a.folder).toBe('Acme')
    expect(b.folder).toBe('ACME (2)')
    const pA = (await api('POST', '/api/projects', adminA, { name: 'Same' }, cx(cA))).json().id
    const pB = (await api('POST', '/api/projects', adminB, { name: 'Same' }, cx(cB))).json().id
    expect((await upload(`/api/projects/${pA}/documents`, adminA, await makePdf(1, 'a'), 'p.pdf', { name: 'Plan' })).statusCode).toBe(200)
    expect((await upload(`/api/projects/${pB}/documents`, adminB, await makePdf(1, 'b'), 'p.pdf', { name: 'Plan' })).statusCode).toBe(200)
    const keys = (await db.query<{ k: string; c: string }>(
      `SELECT r.file_key AS k, p.company_id AS c FROM document_revisions r JOIN documents d ON d.id = r.document_id JOIN projects p ON p.id = d.project_id WHERE p.id = ANY($1::uuid[])`, [[pA, pB]]))
    expect(keys.find(x => x.c === cA)!.k.startsWith('Acme/Projects/')).toBe(true)
    expect(keys.find(x => x.c === cB)!.k.startsWith('ACME (2)/Projects/')).toBe(true)
  })

  it('a rename keeps the folder unless the new name\'s folder is free; the export names the stored folder', async () => {
    // B asks for the name A's folder is called: it keeps its own folder
    expect((await api('PATCH', `/api/companies/${cB}`, adminB, { name: 'acme' })).statusCode).toBe(200)
    expect((await db.query<{ folder: string }>('SELECT folder FROM companies WHERE id = $1', [cB]))[0].folder).toBe('ACME (2)')
    // a free name moves it
    expect((await api('PATCH', `/api/companies/${cB}`, adminB, { name: 'Bravo' })).statusCode).toBe(200)
    expect((await db.query<{ folder: string }>('SELECT folder FROM companies WHERE id = $1', [cB]))[0].folder).toBe('Bravo')
    await app.relayout.drain()
    const ex = await app.inject({ url: `/api/admin/companies/${cB}/export`, headers: { 'x-backup-token': TOKEN } })
    expect(ex.json().company.folder).toBe('Bravo')
    expect((await api('PATCH', `/api/companies/${cB}`, adminB, { name: 'Bravo', keep_folder: true })).statusCode).toBe(200)
  })

  it('the migration gives colliding legacy names distinct folders and queues the move', async () => {
    const d2 = await openDb(undefined, null)
    await migrate(d2)
    const [one] = await d2.query<{ id: string }>("INSERT INTO companies (name, slug) VALUES ('Dup','dup-1') RETURNING id")
    const [two] = await d2.query<{ id: string }>("INSERT INTO companies (name, slug) VALUES ('dup','dup-2') RETURNING id")
    await migrate(d2)
    const rows = await d2.query<{ id: string; folder: string }>('SELECT id, folder FROM companies WHERE id = ANY($1::uuid[]) ORDER BY created_at, id', [[one.id, two.id]])
    expect(rows.map(r => r.folder.toLowerCase())).toEqual(['dup', 'dup (2)'])
    expect(await d2.query("SELECT 1 FROM relayout_jobs WHERE scope = 'company' AND scope_id = $1", [two.id])).toHaveLength(1)
    await expect(d2.query("UPDATE companies SET folder = 'DUP' WHERE id = $1", [two.id])).rejects.toThrow() // unique without case
    await d2.close()
  })
})

describe('3. S3 settings come from the company that owns the file', () => {
  it('two companies with the same bucket name never share credentials', async () => {
    const cfg = (accessKeyId: string) => ({ backend: 's3', s3: { bucket: 'shared-bkt', region: 'auto', accessKeyId, secret: `secret-${accessKeyId}`, pathStyle: false, prefix: '' } })
    expect((await api('PUT', '/api/settings', root, { storage: cfg('AK-A') }, cx(cA))).statusCode).toBe(200)
    expect((await api('PUT', '/api/settings', root, { storage: cfg('AK-B') }, cx(cB))).statusCode).toBe(200)
    const pB = (await api('POST', '/api/projects', adminB, { name: 'On S3' }, cx(cB))).json().id
    const d = (await upload(`/api/projects/${pB}/documents`, adminB, await makePdf(1, 's3'), 's3.pdf', { name: 'S3 plan' })).json()
    expect(d.id).toBeTruthy()
    const [{ file_key }] = await db.query<{ file_key: string }>('SELECT file_key FROM document_revisions WHERE document_id = $1', [d.id])
    expect(file_key).toMatch(/^s3:shared-bkt\//)
    used.length = 0
    expect((await api('GET', `/api/documents/${d.id}/file`, adminB)).statusCode).toBe(200)
    expect([...new Set(used)]).toEqual(['AK-B'])
    // a legacy "s3:name.pdf" key resolves with the company of the row that holds it, not the first company with an S3 config
    objects.set('shared-bkt/legacy-name.pdf', Buffer.from(await makePdf(1, 'legacy')))
    await db.query("UPDATE document_revisions SET file_key = 's3:legacy-name.pdf' WHERE document_id = $1", [d.id])
    used.length = 0
    expect((await api('GET', `/api/documents/${d.id}/file`, adminB)).statusCode).toBe(200)
    expect([...new Set(used)]).toEqual(['AK-B'])
    // the storage layer takes the owner explicitly too
    used.length = 0
    expect(await app.inject({ url: `/api/documents/${d.id}/file`, headers: { authorization: `Bearer ${adminB}` } }).then(r => r.statusCode)).toBe(200)
    await api('PUT', '/api/settings', root, { storage: { backend: 'local' } }, cx(cA))
    await api('PUT', '/api/settings', root, { storage: { backend: 'local' } }, cx(cB))
  })
})

describe('4. sign-in rules and trash retention are install-wide, platform admin only', () => {
  it('company admins cannot change them; a platform admin does, for every company', async () => {
    const cur = (await api('GET', '/api/settings', adminA, undefined, cx(cA))).json()
    const denied = await api('PUT', '/api/settings', adminA, { security: { ...cur.security, session_days: 3 } }, cx(cA))
    expect(denied.statusCode).toBe(403)
    expect((await api('PUT', '/api/settings', adminA, { retention: { trash_days: 1 } }, cx(cA))).statusCode).toBe(403)
    // saving the page unchanged is fine
    expect((await api('PUT', '/api/settings', adminA, { security: cur.security, retention: cur.retention }, cx(cA))).statusCode).toBe(200)
    const ok = await api('PUT', '/api/settings', root, { security: { session_days: 9 }, retention: { trash_days: 5 } }, cx(cA))
    expect(ok.statusCode, ok.body).toBe(200)
    const seenByB = (await api('GET', '/api/settings', adminB, undefined, cx(cB))).json()
    expect(seenByB.security.session_days).toBe(9)
    expect(seenByB.retention.trash_days).toBe(5)
    expect((await db.query<{ value: any }>("SELECT value FROM system_settings WHERE key = 'security'"))[0].value.session_days).toBe(9)
    await api('PUT', '/api/settings', root, { security: { session_days: 30 }, retention: { trash_days: 30 } }, cx(cA))
  })
})

describe('5. project invites: at most a guest, existing accounts must consent, no enumeration', () => {
  it('answers the same for an existing and an unknown email; the existing account gets an invitation', async () => {
    const proj = (await api('POST', '/api/projects', adminA, { name: 'Invite project' }, cx(cA))).json().id
    const known = await api('POST', `/api/projects/${proj}/invites`, adminA, { email: 'memb@x.com', role: 'editor' }, cx(cA))
    const unknown = await api('POST', `/api/projects/${proj}/invites`, adminA, { email: 'nobody-here@x.com', role: 'editor' }, cx(cA))
    expect(known.statusCode).toBe(200)
    expect(unknown.statusCode).toBe(200)
    expect({ ...known.json(), email: '' }).toEqual({ ...unknown.json(), email: '' })
    // the existing account is not in company A yet: it has an invitation as a guest
    expect((await api('GET', '/api/companies', memberB)).json().map((c: any) => c.id)).toEqual([cB])
    const inv = (await api('GET', '/api/company-invitations', memberB)).json()
    expect(inv).toHaveLength(1)
    expect(inv[0]).toMatchObject({ company: { id: cA }, role: 'guest' })
    expect((await api('POST', `/api/company-invitations/${inv[0].id}/accept`, adminB)).statusCode).toBe(404) // not theirs
    expect((await api('POST', `/api/company-invitations/${inv[0].id}/accept`, memberB)).statusCode).toBe(200)
    const [m] = await db.query<{ role: string }>('SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2', [cA, ids.memb])
    expect(m.role).toBe('guest')
    expect((await db.query<{ role: string }>('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [proj, ids.memb]))[0].role).toBe('editor')
    // the brand-new account is a guest too, even if the project admin asked for admin
    const [u] = await db.query<{ id: string }>("SELECT id FROM users WHERE email = 'nobody-here@x.com'")
    expect((await db.query<{ role: string }>('SELECT role FROM company_members WHERE user_id = $1', [u.id]))[0].role).toBe('guest')
  })

  it('declining removes the invitation and nothing else', async () => {
    const r = await api('POST', '/api/invites', adminA, { email: 'admb@x.com', role: 'admin' }, cx(cA))
    expect(r.json()).toMatchObject({ pending_consent: true })
    const inv = (await api('GET', '/api/company-invitations', adminB)).json()
    expect(inv.length).toBeGreaterThan(0)
    expect((await api('POST', `/api/company-invitations/${inv[0].id}/decline`, adminB)).json()).toEqual({ ok: true })
    expect((await api('GET', '/api/company-invitations', adminB)).json()).toEqual([])
    expect(await db.query('SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2', [cA, ids.admb])).toHaveLength(0)
  })
})

describe('6. only platform admins archive a company; 423 for its members', () => {
  it('refuses a company admin and answers 423 "company archived" to members of an archived company', async () => {
    expect((await api('PATCH', `/api/companies/${cB}`, adminB, { archived: true })).statusCode).toBe(403)
    const pB = (await api('GET', '/api/projects', adminB, undefined, cx(cB))).json()[0].id
    expect((await api('PATCH', `/api/companies/${cB}`, root, { archived: true })).json().archived).toBe(true)
    const r = await api('GET', `/api/projects/${pB}`, adminB)
    expect(r.statusCode).toBe(423)
    expect(r.json().error).toBe('company archived')
    expect((await api('GET', `/api/projects/${pB}`, root)).statusCode).toBe(200)
    expect((await api('GET', `/api/projects/${pB}`, adminA)).statusCode).toBe(404) // not their company: still nothing to see
    await api('PATCH', `/api/companies/${cB}`, root, { archived: false })
    expect((await api('GET', `/api/projects/${pB}`, adminB)).statusCode).toBe(200)
  })
})

describe('7. project zip: a few per hour, one at a time', () => {
  it('runs one at a time per user and frees the slot afterwards', async () => {
    const proj = (await api('GET', '/api/projects', adminA, undefined, cx(cA))).json()[0].id
    const both = await Promise.all([api('GET', `/api/projects/${proj}/folder.zip`, adminA), api('GET', `/api/projects/${proj}/folder.zip`, adminA)])
    const codes = both.map(r => r.statusCode).sort()
    expect(codes).toEqual([200, 429])
    expect((await api('GET', `/api/projects/${proj}/folder.zip`, adminA)).statusCode).toBe(200) // the slot was released
  })

  it('is limited per user per hour', async () => {
    const proj = (await api('GET', '/api/projects', root, undefined, cx(cA))).json()[0].id
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await api('GET', `/api/projects/${proj}/folder.zip`, root)).statusCode)
    expect(codes.slice(0, 4)).toEqual([200, 200, 200, 200])
    expect(codes.slice(4)).toEqual([429, 429])
  })
})

describe('8. company admins cannot aim the server at its own network', () => {
  it('refuses private, loopback and link-local S3 endpoints and SMTP hosts; platform admins may', async () => {
    const s3 = (endpoint: string) => ({ backend: 's3', s3: { endpoint, bucket: 'some-bucket', region: 'auto', accessKeyId: 'AK', secret: 'S' } })
    for (const ep of ['http://169.254.169.254', 'http://127.0.0.1:9000', 'https://localhost', 'http://10.1.2.3'])
      expect((await api('PUT', '/api/settings', adminA, { storage: s3(ep) }, cx(cA))).statusCode, ep).toBe(400)
    setHostResolver(async host => (host === 'sneaky.example.test' ? ['10.0.0.5'] : ['93.184.216.34']))
    expect((await api('PUT', '/api/settings', adminA, { storage: s3('https://sneaky.example.test') }, cx(cA))).statusCode).toBe(400)
    expect((await api('PUT', '/api/settings', adminA, { smtp: { host: 'sneaky.example.test', port: 25, from: 'a@b.co' } }, cx(cA))).statusCode).toBe(400)
    expect((await api('PUT', '/api/settings', adminA, { smtp: { host: '169.254.169.254', port: 25, from: 'a@b.co' } }, cx(cA))).statusCode).toBe(400)
    expect((await api('POST', '/api/storage/test', adminA, { s3: s3('http://127.0.0.1:9000').s3 }, cx(cA))).statusCode).toBe(400)
    // public hosts are fine
    expect((await api('PUT', '/api/settings', adminA, { smtp: { host: 'mail.example.org', port: 587, from: 'a@b.co' } }, cx(cA))).statusCode).toBe(200)
    await api('PUT', '/api/settings', adminA, { smtp: { host: '' } }, cx(cA))
    // a platform admin can use a private endpoint (e.g. a MinIO on the LAN)
    expect((await api('POST', '/api/storage/test', root, { s3: s3('http://10.1.2.3:9000').s3 }, cx(cA))).statusCode).toBe(200)
  })

  it('does not echo what the endpoint answered to a company admin', async () => {
    const bad = { endpoint: 'https://objects.example.org', bucket: 'some-bucket', region: 'auto', accessKeyId: 'AK-ERR', secret: 'S' }
    const mine = await api('POST', '/api/storage/test', adminA, { s3: bad }, cx(cA))
    expect(mine.statusCode).toBe(400)
    expect(mine.body).not.toContain('SECRET-INTERNAL-DETAIL')
    expect(mine.body).not.toContain('10.0.0.5')
    expect((await api('POST', '/api/storage/test', root, { s3: bad }, cx(cA))).body).toContain('SECRET-INTERNAL-DETAIL')
  })
})

describe('minor: moving a project looks cable types up in the source company only', () => {
  it('does not read or copy another company\'s cable type', async () => {
    const co = async (n: string) => (await db.query<{ id: string }>("INSERT INTO companies (name, slug, folder) VALUES ($1,$2,$1) RETURNING id", [n, n.toLowerCase()]))[0].id
    const src = await co('MvSrc'), dst = await co('MvDst'), other = await co('MvOther')
    const [foreign] = await db.query<{ id: string }>("INSERT INTO cable_types (company_id, name) VALUES ($1,'Secret cable') RETURNING id", [other])
    const [p] = await db.query<{ id: string }>("INSERT INTO projects (company_id, name) VALUES ($1,'Mover') RETURNING id", [src])
    const [d] = await db.query<{ id: string }>("INSERT INTO documents (project_id, name) VALUES ($1,'D') RETURNING id", [p.id])
    await db.query(
      `INSERT INTO markups (id, document_id, page, type, geometry, fields) VALUES (gen_random_uuid(), $1, 1, 'cable', '{}', $2)`, [d.id, JSON.stringify({ cable_type: foreign.id })])
    const out = await moveProject(db, p.id, dst)
    expect('summary' in out && out.summary.cable_types).toEqual({ matched: 0, copied: 0 })
    expect(await db.query("SELECT 1 FROM cable_types WHERE company_id = $1", [dst])).toHaveLength(0)
  })
})

describe('relayout robustness', () => {
  const insertPlan = async (companyId: string, name: string, key: string, snapshot: unknown = null) => {
    const [p] = await db.query<{ id: string }>('INSERT INTO projects (company_id, name) VALUES ($1,$2) RETURNING id', [companyId, name])
    const [d] = await db.query<{ id: string }>('INSERT INTO documents (project_id, name) VALUES ($1,$2) RETURNING id', [p.id, name])
    const [r] = await db.query<{ id: string }>(
      'INSERT INTO document_revisions (document_id, revision, file_key, page_count, attachments_snapshot) VALUES ($1,1,$2,1,$3) RETURNING id', [d.id, key, snapshot ? JSON.stringify(snapshot) : null])
    return { project: p.id, doc: d.id, rev: r.id }
  }

  it('markup and photo renames of one document share a single job', async () => {
    const [m] = await db.query<{ id: string }>('SELECT company_id AS id FROM projects LIMIT 1'); void m
    const { doc } = await insertPlan(cZ, 'Coalesce', 'keep/coalesce.pdf')
    const mk = '22222222-2222-4222-8222-222222222222', at = '33333333-3333-4333-8333-333333333333'
    await db.query("INSERT INTO markups (id, document_id, page, type, geometry) VALUES ($1,$2,1,'pin','{}')", [mk, doc])
    await db.query("INSERT INTO attachments (id, markup_id, file_key) VALUES ($1,$2,'keep/photo.jpg')", [at, mk])
    await app.relayout.drain()
    await db.query("UPDATE markups SET tag = 'CAM-01' WHERE id = $1", [mk])
    await db.query("UPDATE attachments SET caption = 'new caption' WHERE id = $1", [at])
    await db.query("UPDATE markups SET tag = 'CAM-02' WHERE id = $1", [mk])
    const jobs = await db.query<{ scope: string; scope_id: string }>("SELECT scope, scope_id FROM relayout_jobs WHERE status = 'pending' AND kind = 'relayout'")
    expect(jobs.filter(j => j.scope === 'markup' || j.scope === 'attachment')).toHaveLength(0)
    expect(jobs.filter(j => j.scope === 'document' && j.scope_id === doc)).toHaveLength(1)
    await db.query("DELETE FROM relayout_jobs WHERE status = 'pending'")
  })

  it('a snapshot written after the move was planned is still rewritten inside the commit', async () => {
    const { project, rev } = await insertPlan(cZ, 'Snap', 'snap/p.pdf', [{ markup_id: null, file_key: 'old/photo.jpg', annotated_key: null }])
    await db.transaction(q => updateRefs(q, 'old/photo.jpg', 'new/photo.jpg', { holder: 'photo', companyId: cZ, projectId: project, snapshotRevs: [] }))
    const [r] = await db.query<{ s: any }>('SELECT attachments_snapshot AS s FROM document_revisions WHERE id = $1', [rev])
    expect(r.s[0].file_key).toBe('new/photo.jpg')
  })

  it('sweeps originals left behind by a crash between commit and delete, and only those no row names', async () => {
    mkdirSync(path.join(filesDir, 'Left'), { recursive: true })
    writeFileSync(path.join(filesDir, 'Left', 'orphan.pdf'), 'x')
    writeFileSync(path.join(filesDir, 'Left', 'live.pdf'), 'y')
    await insertPlan(cZ, 'Live', 'Left/live.pdf')
    const [empty] = await db.query<{ id: string }>("INSERT INTO projects (company_id, name) VALUES ($1,'Empty') RETURNING id", [cZ])
    await db.query(
      `INSERT INTO relayout_jobs (kind, scope, scope_id, company_id, pending_unlinks) VALUES ('relayout','project',$1,$2,$3::jsonb)`,
      [empty.id, cZ, JSON.stringify([{ key: 'Left/orphan.pdf', company: cZ }, { key: 'Left/live.pdf', company: cZ }])])
    await app.relayout.drain()
    expect(existsSync(path.join(filesDir, 'Left', 'orphan.pdf'))).toBe(false)
    expect(existsSync(path.join(filesDir, 'Left', 'live.pdf'))).toBe(true)
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM relayout_jobs WHERE pending_unlinks <> '[]'::jsonb"))[0].n).toBe(0)
  })

  it('the worker can be paused (backups) through the internal token and resumes', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/internal/relayout/pause' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/internal/relayout/pause', headers: { 'x-backup-token': 'wrong-token-wrong-token-1' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/internal/relayout/pause', headers: { 'x-backup-token': TOKEN } })).statusCode).toBe(200)
    expect(app.relayout.paused).toBe(true)
    await app.relayout.enqueue('relayout', { type: 'company', id: cA })
    expect(await app.relayout.tick()).toBe(false) // nothing moves while paused
    expect((await db.query("SELECT 1 FROM relayout_jobs WHERE status = 'pending'")).length).toBeGreaterThan(0)
    expect((await app.inject({ method: 'POST', url: '/api/internal/relayout/resume', headers: { 'x-backup-token': TOKEN } })).statusCode).toBe(200)
    await app.relayout.drain()
    expect(await db.query("SELECT 1 FROM relayout_jobs WHERE status IN ('pending','running')")).toHaveLength(0)
  })

  it('the export reports queued moves so the backup skips the folder copy', async () => {
    await app.relayout.enqueue('relayout', { type: 'company', id: cA })
    const ex = await app.inject({ url: `/api/admin/companies/${cA}/export`, headers: { 'x-backup-token': TOKEN } })
    expect(ex.json().relayout_pending).toBeGreaterThan(0)
    await app.relayout.drain()
    expect((await app.inject({ url: `/api/admin/companies/${cA}/export`, headers: { 'x-backup-token': TOKEN } })).json().relayout_pending).toBe(0)
  })

  it('a case-only rename keeps the plain name (no " (2)")', async () => {
    const root2 = mkdtempSync(path.join(tmpdir(), 'pm-case-'))
    const s = new Storage(root2)
    const k = await s.save({ kind: 'plan', ext: 'pdf', company: 'Acme', project: 'HQ', plan: 'L1', rev: 1, at: new Date(Date.UTC(2026, 0, 2)), original: 'plan.pdf' }, Buffer.from('c'))
    const target = k.replace('Plans/L1', 'Plans/l1')
    const moved = await s.relocate(k, target)
    expect(moved).toBe(target)
    expect((await s.read(moved))?.toString()).toBe('c')
  })

  it('saving the company settings with a new name refreshes the cached company', async () => {
    expect((await api('GET', '/api/me', adminA, undefined, cx(cA))).json().company.name).toBe('Acme')
    expect((await api('PUT', '/api/settings', adminA, { company: { name: 'Acme Renamed' } }, cx(cA))).statusCode).toBe(200)
    expect((await api('GET', '/api/me', adminA, undefined, cx(cA))).json().company.name).toBe('Acme Renamed')
    await app.relayout.drain()
  })
})
