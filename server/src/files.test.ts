// Readable file storage end to end: layout on upload, re-layout after renames, "Organize files" (dry run, apply, resume),
// trash, the project folder zip and the internal backup token.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import { buildApp } from './app.js'
import { Relayout } from './relayout.js'
import { crc32 } from './zip.js'
import { fakeS3Client, makePdf } from './testutil.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Awaited<ReturnType<typeof openDb>>
let filesDir = '', rcloneDir = ''
const objects = new Map<string, Buffer>()
const fakeS3 = () => fakeS3Client(objects)
const savedEnv = { key: process.env.BACKUP_ENCRYPTION_KEY, dir: process.env.RCLONE_DIR, tok: process.env.BACKUP_INTERNAL_TOKEN }

const api = (method: string, url: string, token: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })
const cx = (id: string) => ({ 'x-company-id': id })
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1' } })).json().token as string
const mpFile = (field: string, file: Buffer, name: string, type: string, fields: Record<string, string> = {}) => Buffer.concat([
  ...Object.entries(fields).map(([k, v]) => Buffer.from(`--SB\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
  Buffer.from(`--SB\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), file, Buffer.from('\r\n--SB--\r\n')])
const upload = (url: string, token: string, body: Buffer, method = 'POST') =>
  app.inject({ method: method as any, url, payload: body, headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=SB' } })
const JPG = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, 2, 3, 4])

let root = '', c1 = '', c2 = ''
let project = '', doc = '', markup = '', setId = '', typeId = ''
let attachment = ''
const keyOf = async (sql: string, p: unknown[] = []) => (await db.query<{ k: string }>(sql, p))[0]?.k
const revKey = (docId = doc) => keyOf('SELECT file_key AS k FROM document_revisions WHERE document_id = $1 ORDER BY revision LIMIT 1', [docId])
const photoKey = () => keyOf('SELECT file_key AS k FROM attachments WHERE id = $1', [attachment])
const fileExists = (key: string) => existsSync(path.join(filesDir, ...key.split('/')))
const drain = () => app.relayout.drain()

beforeAll(async () => {
  rcloneDir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-ft-')), '.rclone')
  process.env.BACKUP_ENCRYPTION_KEY = 'a-test-key-that-is-long-enough'
  process.env.RCLONE_DIR = rcloneDir
  process.env.BACKUP_INTERNAL_TOKEN = 'internal-token-for-the-tests-0123456789'
  db = await openDb(undefined, null)
  await migrate(db)
  filesDir = mkdtempSync(path.join(tmpdir(), 'pm-ft-f-'))
  app = await buildApp({ db, jwtSecret: 'test', filesDir, s3Factory: fakeS3, publicUrl: 'https://pm.example.com' })
  root = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'root@x.com', name: 'Root', password: 'password1', setupCode: 'test-setup-code' } })).json().token
  c1 = (await api('GET', '/api/companies', root)).json()[0].id
  await api('PATCH', `/api/companies/${c1}`, root, { name: 'Acme Security' })
  c2 = (await api('POST', '/api/companies', root, { name: 'Beta Co' })).json().id
  await drain()
  ;[{ id: setId }] = await db.query("SELECT id FROM symbol_sets WHERE company_id = $1 AND name = 'Cameras'", [c1])
  ;[{ id: typeId }] = await db.query("SELECT id FROM device_types WHERE symbol_set_id = $1 AND name = 'IP Camera'", [setId])
  project = (await api('POST', '/api/projects', root, { name: 'HQ Tower' }, cx(c1))).json().id
  const d = (await upload(`/api/projects/${project}/documents`, root, mpFile('file', await makePdf(1, 'l1'), 'Level 1 final.pdf', 'application/pdf', { name: 'Level 1' }))).json()
  doc = d.id
  markup = '11111111-1111-4111-8111-111111111111'
  const m = await api('PUT', `/api/documents/${doc}/markups/${markup}`, root, { page: 1, type: 'device', geometry: { x: 0, y: 0, width: 24, height: 24, rotation: 0 }, symbol_set_id: setId, device_type_id: typeId, status: 'planned' })
  expect(m.statusCode, m.body).toBe(200)
  attachment = '22222222-2222-4222-8222-222222222222'
  const a = await upload(`/api/markups/${markup}/attachments`, root, mpFile('photo', JPG(1), 'p.jpg', 'image/jpeg', { id: attachment, caption: 'Door side' }))
  expect(a.statusCode, a.body).toBe(200)
})

afterAll(async () => {
  await app.close()
  for (const [k, v] of [['BACKUP_ENCRYPTION_KEY', savedEnv.key], ['RCLONE_DIR', savedEnv.dir], ['BACKUP_INTERNAL_TOKEN', savedEnv.tok]] as const)
    if (v === undefined) delete process.env[k]; else process.env[k] = v
})

describe('new files get a readable place', () => {
  it('names the plan, photo, logo and avatar by company, project, plan and device', async () => {
    expect(await revKey()).toMatch(/^Acme Security\/Projects\/HQ Tower\/Plans\/Level 1\/Rev 01 - \d{4}-\d{2}-\d{2} - Level 1 final\.pdf$/)
    expect(await photoKey()).toMatch(/^Acme Security\/Projects\/HQ Tower\/Photos\/Level 1\/CAM-01 - IP Camera\/\d{4}-\d{2}-\d{2} \d{4} - Door side\.jpg$/)
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])
    expect((await upload('/api/settings/logo', root, mpFile('file', png, 'l.png', 'image/png'))).statusCode).toBe(200)
    expect((await upload(`/api/projects/${project}/logo`, root, mpFile('file', png, 'l.png', 'image/png'))).statusCode).toBe(200)
    const settingsKey = await keyOf("SELECT value->>'logo_key' AS k FROM settings WHERE company_id = $1 AND key = 'company'", [c1])
    expect(settingsKey).toBe('Acme Security/_company/logo.png')
    expect(await keyOf("SELECT settings->'report'->>'logo_key' AS k FROM projects WHERE id = $1", [project])).toBe('Acme Security/Projects/HQ Tower/_project/report-logo.png')
    expect((await upload('/api/me/avatar', root, mpFile('photo', JPG(9), 'a.jpg', 'image/jpeg'))).statusCode).toBe(200)
    expect(await keyOf('SELECT avatar_key AS k FROM users WHERE email = $1', ['root@x.com'])).toBe('_users/root@x.com/avatar.jpg')
    // and they all still download
    expect((await api('GET', `/api/attachments/${attachment}/file`, root)).rawPayload.equals(JPG(1))).toBe(true)
    expect((await api('GET', '/api/company/logo', root, undefined, cx(c1))).statusCode).toBe(200)
  })

  it('a second photo with the same caption in the same minute gets (2)', async () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const r = await upload(`/api/markups/${markup}/attachments`, root, mpFile('photo', JPG(2), 'p.jpg', 'image/jpeg', { id, caption: 'Door side' }))
    expect(r.statusCode, r.body).toBe(200)
    const k = await keyOf('SELECT file_key AS k FROM attachments WHERE id = $1', [id])
    expect(k).toMatch(/Door side( \(2\))?\.jpg$/) // (2) unless the clock crossed a minute between the two uploads
    expect((await api('GET', `/api/attachments/${id}/file`, root)).rawPayload.equals(JPG(2))).toBe(true)
    await api('DELETE', `/api/attachments/${id}`, root)
  })
})

describe('re-layout after a rename', () => {
  it('queues jobs when a name changes, and the worker moves the files and rewrites every reference', async () => {
    // freeze the photo into a revision snapshot (an issued revision keeps attachments_snapshot) so its key is stored in jsonb too
    expect((await api('POST', `/api/documents/${doc}/revisions/issue`, root, { label: 'IFC' })).statusCode).toBe(200)
    const oldPhoto = (await photoKey())!, oldPlan = (await revKey())!
    expect((await api('PATCH', `/api/projects/${project}`, root, { name: 'HQ Tower East' })).statusCode).toBe(200)
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM relayout_jobs WHERE kind = 'relayout' AND status = 'pending'")
    expect(n).toBeGreaterThan(0)
    await drain()
    const newPhoto = (await photoKey())!, newPlan = (await revKey())!
    expect(newPlan).toContain('/Projects/HQ Tower East/Plans/Level 1/')
    expect(newPhoto).toContain('/Projects/HQ Tower East/Photos/')
    expect(fileExists(oldPhoto) || fileExists(oldPlan)).toBe(false)
    expect(fileExists(newPhoto) && fileExists(newPlan)).toBe(true)
    // the frozen copies, the project logo and every revision row follow
    const [snap] = await db.query<{ t: string }>("SELECT attachments_snapshot::text AS t FROM document_revisions WHERE document_id = $1 AND attachments_snapshot IS NOT NULL LIMIT 1", [doc])
    expect(snap.t).toContain(JSON.stringify(newPhoto))
    expect(snap.t).not.toContain(JSON.stringify(oldPhoto))
    expect(await keyOf("SELECT settings->'report'->>'logo_key' AS k FROM projects WHERE id = $1", [project])).toContain('/HQ Tower East/_project/')
    expect((await db.query("SELECT 1 FROM document_revisions WHERE file_key = $1", [oldPlan]))).toHaveLength(0)
    expect((await api('GET', `/api/attachments/${attachment}/file`, root)).rawPayload.equals(JPG(1))).toBe(true)
    expect((await api('GET', `/api/documents/${doc}/file`, root)).statusCode).toBe(200)
    expect(readdirSync(path.join(filesDir, 'Acme Security', 'Projects'))).toEqual(['HQ Tower East']) // no empty leftovers
  })

  it('follows a plan rename, a device tag change, a caption change and a company rename', async () => {
    expect((await api('PATCH', `/api/documents/${doc}`, root, { name: 'Ground floor' })).statusCode).toBe(200)
    await drain()
    expect(await photoKey()).toContain('/Photos/Ground floor/CAM-01 - IP Camera/')
    expect(await revKey()).toContain('/Plans/Ground floor/')

    const cur = (await api('GET', `/api/documents/${doc}/markups`, root)).json().find((m: any) => m.id === markup)
    const put = await api('PUT', `/api/documents/${doc}/markups/${markup}`, root, { ...cur, tag: 'CAM-77', base_version: cur.version })
    expect(put.statusCode, put.body).toBe(200)
    await drain()
    expect(await photoKey()).toContain('/Photos/Ground floor/CAM-77 - IP Camera/')

    expect((await api('PATCH', `/api/attachments/${attachment}`, root, { caption: 'Rear / door: "left"' })).statusCode).toBe(200)
    await drain()
    const k = (await photoKey())!
    expect(k).toMatch(/\d{4} - Rear door left\.jpg$/) // forbidden characters are gone

    await db.query("UPDATE device_types SET name = 'Dome Camera' WHERE id = $1", [typeId])
    await drain()
    expect(await photoKey()).toContain('/CAM-77 - Dome Camera/')

    expect((await api('PATCH', `/api/companies/${c1}`, root, { name: 'Acme Group' })).statusCode).toBe(200)
    await drain()
    expect(await photoKey()).toMatch(/^Acme Group\/Projects\/HQ Tower East\//)
    expect(await keyOf("SELECT value->>'logo_key' AS k FROM settings WHERE company_id = $1 AND key = 'company'", [c1])).toBe('Acme Group/_company/logo.png')
    expect(readdirSync(filesDir).filter(n => !n.startsWith('_')).sort()).toEqual(['Acme Group'])
    expect((await api('GET', `/api/attachments/${attachment}/file`, root)).rawPayload.equals(JPG(1))).toBe(true)
  })

  it('is idempotent and leaves nothing queued', async () => {
    const before = await photoKey()
    await drain()
    expect(await photoKey()).toBe(before)
    expect(await db.query("SELECT 1 FROM relayout_jobs WHERE status IN ('pending','running')")).toHaveLength(0)
  })

  it('moves the files when a project moves to another company', async () => {
    const p2 = (await api('POST', '/api/projects', root, { name: 'Mover' }, cx(c1))).json().id
    const d2 = (await upload(`/api/projects/${p2}/documents`, root, mpFile('file', await makePdf(1, 'mv'), 'mv.pdf', 'application/pdf'))).json()
    expect(await revKey(d2.id)).toContain('Acme Group/Projects/Mover/')
    const r = await api('POST', `/api/projects/${p2}/move`, root, { company_id: c2 })
    expect(r.statusCode, r.body).toBe(200)
    await drain()
    expect(await revKey(d2.id)).toMatch(/^Beta Co\/Projects\/Mover\/Plans\/mv\//)
    expect((await api('GET', `/api/documents/${d2.id}/file`, root)).statusCode).toBe(200)
  })
})

describe('Organize files', () => {
  let legacyPhoto = '', legacyPlan = '', missingKey = ''
  const putLegacy = (name: string, bytes: Buffer) => { writeFileSync(path.join(filesDir, name), bytes) }

  it('previews and applies moves for old flat files, only for the caller\'s company', async () => {
    legacyPhoto = '0f8fad5b-d9cb-469f-a165-70867728950e.jpg'; putLegacy(legacyPhoto, JPG(5))
    legacyPlan = '1f8fad5b-d9cb-469f-a165-70867728950e.pdf'; putLegacy(legacyPlan, await makePdf(1, 'old'))
    missingKey = '2f8fad5b-d9cb-469f-a165-70867728950e.jpg' // referenced but the file is gone
    const att2 = '44444444-4444-4444-8444-444444444444', att3 = '55555555-5555-4555-8555-555555555555'
    await db.query('INSERT INTO attachments (id, markup_id, file_key, caption) VALUES ($1,$2,$3,$4)', [att2, markup, legacyPhoto, 'old photo'])
    await db.query('INSERT INTO attachments (id, markup_id, file_key, caption) VALUES ($1,$2,$3,$4)', [att3, markup, missingKey, 'lost photo'])
    await db.query('INSERT INTO document_revisions (document_id, revision, file_key, page_count, kind) VALUES ($1, 9, $2, 1, $3)', [doc, legacyPlan, 'upload'])
    // another company's legacy file must not be touched by company 1's run
    const p3 = (await api('POST', '/api/projects', root, { name: 'Beta job' }, cx(c2))).json().id
    const d3 = (await upload(`/api/projects/${p3}/documents`, root, mpFile('file', await makePdf(1, 'b'), 'b.pdf', 'application/pdf'))).json()
    const betaLegacy = '3f8fad5b-d9cb-469f-a165-70867728950e.pdf'; putLegacy(betaLegacy, await makePdf(1, 'beta-old'))
    await db.query('UPDATE document_revisions SET file_key = $2 WHERE document_id = $1', [d3.id, betaLegacy])

    // non-admins and non-platform admins are refused
    const outsider = (await api('POST', '/api/users', root, { email: 'pat@x.com', name: 'Pat', password: 'password1' }, cx(c1))).json()
    expect(outsider.id).toBeTruthy()
    const pat = await login('pat@x.com')
    expect((await api('POST', '/api/admin/storage/organize/preview', pat, {}, cx(c1))).statusCode).toBe(403)
    expect((await api('POST', '/api/admin/storage/organize/preview', pat, { scope: 'all' }, cx(c1))).statusCode).toBe(403)
    expect((await api('POST', '/api/admin/storage/organize/apply', pat, {}, cx(c1))).statusCode).toBe(403)
    expect((await api('GET', '/api/admin/storage/organize/status', pat, undefined, cx(c1))).statusCode).toBe(403)

    // dry run: counts and samples, nothing moves
    const prev = await api('POST', '/api/admin/storage/organize/preview', root, {}, cx(c1))
    expect(prev.statusCode, prev.body).toBe(200)
    expect(prev.json()).toMatchObject({ scope: 'company', to_move: 3, legacy_to_move: 3 })
    expect(prev.json().samples.map((s: any) => s.from).sort()).toEqual([legacyPhoto, legacyPlan, missingKey].sort())
    expect(prev.json().samples.every((s: any) => s.to.startsWith('Acme Group/'))).toBe(true)
    expect(fileExists(legacyPhoto)).toBe(true)

    // apply (the worker is not running in tests: drain does its job); the missing file is reported, the rest moves
    const ap = await api('POST', '/api/admin/storage/organize/apply', root, {}, cx(c1))
    expect(ap.statusCode).toBe(202)
    expect(ap.json().status).toBe('pending')
    await drain()
    const st = (await api('GET', '/api/admin/storage/organize/status', root, undefined, cx(c1))).json()
    expect(st).toMatchObject({ status: 'done', total: 3, moved: 2, failed: 1 })
    expect(st.error).toContain(missingKey)
    const movedPhoto = await keyOf('SELECT file_key AS k FROM attachments WHERE id = $1', [att2])
    expect(movedPhoto).toMatch(/^Acme Group\/Projects\/HQ Tower East\/Photos\/Ground floor\/CAM-77 - Dome Camera\/.* - old photo\.jpg$/)
    expect(fileExists(movedPhoto!)).toBe(true)
    expect(fileExists(legacyPhoto)).toBe(false)
    expect(await keyOf('SELECT file_key AS k FROM document_revisions WHERE revision = 9 AND document_id = $1', [doc])).toMatch(/Rev 09 - .* - Ground floor\.pdf$/)
    expect((await api('GET', `/api/attachments/${att2}/file`, root)).rawPayload.equals(JPG(5))).toBe(true)
    // the other company is untouched
    expect(await revKey(d3.id)).toBe(betaLegacy)
    expect(fileExists(betaLegacy)).toBe(true)
    // running it again finds only the unfixable one
    const again = (await api('POST', '/api/admin/storage/organize/preview', root, {}, cx(c1))).json()
    expect(again.to_move).toBe(1)
    await db.query('DELETE FROM attachments WHERE id = $1', [att3])
    expect((await api('POST', '/api/admin/storage/organize/preview', root, {}, cx(c1))).json().to_move).toBe(0)
  })

  it('an all-companies run is for platform admins and also organizes the other company and avatars', async () => {
    const prev = (await api('POST', '/api/admin/storage/organize/preview', root, { scope: 'all' })).json()
    expect(prev).toMatchObject({ scope: 'all', to_move: 1 })
    const ap = await api('POST', '/api/admin/storage/organize/apply', root, { scope: 'all' })
    expect(ap.statusCode).toBe(202)
    await drain()
    expect((await api('GET', '/api/admin/storage/organize/status?scope=all', root)).json()).toMatchObject({ status: 'done', moved: 1, failed: 0 })
    const d = (await db.query<{ k: string }>("SELECT file_key AS k FROM document_revisions WHERE file_key LIKE 'Beta Co/%' AND file_key LIKE '%b%' ORDER BY file_key"))
    expect(d.some(r => r.k.includes('beta-old') || r.k.includes('Rev 01'))).toBe(true)
    expect(fileExists('3f8fad5b-d9cb-469f-a165-70867728950e.pdf')).toBe(false)
  })

  it('a job interrupted part way resumes where it stopped (also after a restart)', async () => {
    const ids = ['a', 'b', 'c', 'd'].map((x, i) => `66666666-6666-4666-8666-66666666666${i}`)
    for (let i = 0; i < ids.length; i++) {
      const k = `7f8fad5b-d9cb-469f-a165-7086772895${i}0.jpg`
      writeFileSync(path.join(filesDir, k), JPG(20 + i))
      await db.query('INSERT INTO attachments (id, markup_id, file_key, caption) VALUES ($1,$2,$3,$4)', [ids[i], markup, k, `resume ${i}`])
    }
    const first = new Relayout(db, storageOf(), { batch: 1 })
    const job = await first.enqueue('organize', { type: 'company', id: c1 })
    expect(await first.tick()).toBe(true)
    const mid = await first.organizeStatus(c1)
    expect(mid).toMatchObject({ status: 'running', total: 4, moved: 1 })
    // "restart": a fresh worker continues the same job
    const second = new Relayout(db, storageOf(), { batch: 2 })
    await second.drain()
    expect(await second.organizeStatus(c1)).toMatchObject({ id: job.id, status: 'done', total: 4, moved: 4, failed: 0 })
    for (const id of ids) expect(await keyOf('SELECT file_key AS k FROM attachments WHERE id = $1', [id])).toMatch(/resume \d\.jpg$/)
    // queueing the same job twice while one is open returns the open one
    const a = await second.enqueue('organize', { type: 'company', id: c1 }), b = await second.enqueue('organize', { type: 'company', id: c1 })
    expect(b.id).toBe(a.id)
    await second.drain()
  })
})

// The app does not expose its storage; tests build an equivalent one over the same directory.
import { Storage } from './storage.js'
function storageOf() { return new Storage(filesDir) }

describe('trash', () => {
  it('deleting a photo moves its file to _trash and purge removes it later', async () => {
    const id = '88888888-8888-4888-8888-888888888888'
    expect((await upload(`/api/markups/${markup}/attachments`, root, mpFile('photo', JPG(40), 'p.jpg', 'image/jpeg', { id, caption: 'to delete' }))).statusCode).toBe(200)
    const key = (await keyOf('SELECT file_key AS k FROM attachments WHERE id = $1', [id]))!
    expect((await api('DELETE', `/api/attachments/${id}`, root)).statusCode).toBe(200)
    await new Promise(r => setTimeout(r, 300)) // removal after delete is a background task
    expect(fileExists(key)).toBe(false)
    const stamps = readdirSync(path.join(filesDir, '_trash'))
    expect(stamps.some(st => existsSync(path.join(filesDir, '_trash', st, ...key.split('/'))))).toBe(true)
    expect(await app.relayout.purge()).toBe(0) // young
    expect(await new Storage(filesDir).purgeTrash(30, Date.now() + 40 * 86_400_000)).toBeGreaterThan(0)
    expect(existsSync(path.join(filesDir, '_trash'))).toBe(true)
    expect(readdirSync(path.join(filesDir, '_trash'))).toEqual([])
  })

  it('retention.trash_days is a company setting (0 = delete at once)', async () => {
    const r = await api('PUT', '/api/settings', root, { retention: { trash_days: 0 } }, cx(c1))
    expect(r.statusCode, r.body).toBe(200)
    expect((await api('GET', '/api/settings', root, undefined, cx(c1))).json().retention.trash_days).toBe(0)
    await api('PUT', '/api/settings', root, { retention: { trash_days: 30 } }, cx(c1))
    expect((await api('GET', '/api/settings', root, undefined, cx(c1))).json().retention.trash_days).toBe(30)
  })
})

/** Reads a zip with the central directory (what Explorer, 7-Zip and unzip do) and checks every CRC. */
function readZip(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBeGreaterThan(-1)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50)
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    expect(buf.readUInt32LE(off)).toBe(0x04034b50)
    const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const raw = buf.subarray(dataStart, dataStart + csize)
    const data = method === 8 ? inflateRawSync(raw) : raw
    expect(data.length, name).toBe(usize)
    expect(crc32(data), name).toBe(crc)
    files.set(name, Buffer.from(data))
    p += 46 + nameLen + extraLen + cmtLen
  }
  return files
}

describe('project folder zip', () => {
  it('streams the project in the on-disk layout with a device list, for members who can view', async () => {
    const viewer = (await api('POST', '/api/users', root, { email: 'vic@x.com', name: 'Vic', password: 'password1' }, cx(c1))).json()
    await api('PUT', `/api/projects/${project}/members`, root, { email: 'vic@x.com', role: 'viewer' })
    const vic = await login('vic@x.com')
    const res = await api('GET', `/api/projects/${project}/folder.zip`, vic)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain('HQ Tower East.zip')
    const files = readZip(res.rawPayload)
    const names = [...files.keys()]
    expect(names.every(n => n.startsWith('HQ Tower East/'))).toBe(true)
    expect(names.some(n => /^HQ Tower East\/Plans\/Ground floor\/Rev 01 - .*Level 1 final\.pdf$/.test(n))).toBe(true)
    expect(names.some(n => /^HQ Tower East\/Photos\/Ground floor\/CAM-77 - Dome Camera\/.* - Rear door left\.jpg$/.test(n))).toBe(true)
    expect(names).toContain('HQ Tower East/_project/report-logo.png')
    const photo = names.find(n => n.endsWith('Rear door left.jpg'))!
    expect(files.get(photo)!.equals(JPG(1))).toBe(true)
    const csv = files.get('HQ Tower East/devices.csv')!.toString('utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('CAM-77')
    const header = csv.slice(1, csv.indexOf('\r\n')).split(',')
    expect(header.slice(0, 13)).toEqual(['tag', 'type', 'set', 'plan', 'page', 'status', 'manufacturer', 'model', 'ip', 'mac', 'serial', 'room', 'notes'])
    expect(new Set(header).size).toBe(header.length) // no duplicated columns
    expect(csv).toContain('Dome Camera')
    const json = JSON.parse(files.get('HQ Tower East/devices.json')!.toString('utf8'))
    expect(json.devices[0]).toMatchObject({ tag: 'CAM-77', device_type: 'Dome Camera', plan: 'Ground floor' })
    // same bytes as the stored plan
    const plan = names.find(n => n.endsWith('Level 1 final.pdf'))!
    expect(files.get(plan)!.equals((await readFile(await revKey())) as Buffer)).toBe(true)
  })

  it('refuses people outside the project or the company, and signed-out requests', async () => {
    const other = (await api('POST', '/api/users', root, { email: 'omar@x.com', name: 'Omar', password: 'password1' }, cx(c2))).json()
    expect(other.id).toBeTruthy()
    const omar = await login('omar@x.com')
    expect((await api('GET', `/api/projects/${project}/folder.zip`, omar)).statusCode).toBe(404)
    const pat = await login('pat@x.com') // in the company but not on the project
    expect((await api('GET', `/api/projects/${project}/folder.zip`, pat)).statusCode).toBe(403)
    expect((await api('GET', `/api/projects/${project}/folder.zip`, '')).statusCode).toBe(401)
    expect((await api('GET', '/api/projects/not-a-uuid/folder.zip', root)).statusCode).toBe(404)
  })

  it('a sub only gets the photos and devices in its scope', async () => {
    const sub = (await api('POST', '/api/users', root, { email: 'sue@x.com', name: 'Sue', password: 'password1' }, cx(c1))).json()
    const [other] = await db.query<{ id: string }>("SELECT id FROM symbol_sets WHERE company_id = $1 AND name = 'Fire Alarm'", [c1])
    const r = await api('PUT', `/api/projects/${project}/members`, root, { email: 'sue@x.com', role: 'sub', scope: { sets: [other.id], layers: [] } })
    expect(r.statusCode, r.body).toBe(200)
    const files = readZip((await api('GET', `/api/projects/${project}/folder.zip`, await login('sue@x.com'))).rawPayload)
    expect([...files.keys()].some(n => n.includes('/Photos/'))).toBe(false)
    expect(JSON.parse(files.get('HQ Tower East/devices.json')!.toString()).devices).toEqual([])
  })
})
import { readFile as readFileAsync } from 'node:fs/promises'
const readFile = async (key: string) => readFileAsync(path.join(filesDir, ...key.split('/')))

describe('backup token and target scopes', () => {
  const TOKEN = 'internal-token-for-the-tests-0123456789'
  it('the export route accepts the internal token and nothing else does', async () => {
    const url = `/api/admin/companies/${c1}/export`
    expect((await app.inject(url)).statusCode).toBe(401)
    expect((await app.inject({ url, headers: { 'x-backup-token': 'wrong-token-wrong-token-1234' } })).statusCode).toBe(401)
    const ok = await app.inject({ url, headers: { 'x-backup-token': TOKEN } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().company).toMatchObject({ id: c1, name: 'Acme Group', folder: 'Acme Group' })
    // another company id works the same way: the token is the install's, it is not tied to a user
    expect((await app.inject({ url: `/api/admin/companies/${c2}/export`, headers: { 'x-backup-token': TOKEN } })).json().company.folder).toBe('Beta Co')
    // the token opens that one route only
    for (const other of ['/api/projects', '/api/companies', '/api/settings', `/api/admin/backups`, '/api/me'])
      expect((await app.inject({ url: other, headers: { 'x-backup-token': TOKEN } })).statusCode, other).toBe(401)
    // and a too-short or missing server token disables it
    const keep = process.env.BACKUP_INTERNAL_TOKEN
    process.env.BACKUP_INTERNAL_TOKEN = 'short'
    expect((await app.inject({ url, headers: { 'x-backup-token': 'short' } })).statusCode).toBe(401)
    delete process.env.BACKUP_INTERNAL_TOKEN
    expect((await app.inject({ url, headers: { 'x-backup-token': '' } })).statusCode).toBe(401)
    process.env.BACKUP_INTERNAL_TOKEN = keep
    // a company admin of another company still cannot read this export
    const carol = (await api('POST', '/api/users', root, { email: 'carol@x.com', name: 'Carol', password: 'password1', isAdmin: true }, cx(c2))).json()
    expect(carol.id).toBeTruthy()
    expect((await api('GET', url, await login('carol@x.com'))).statusCode).toBe(404)
  })

  it('only a platform admin makes system-level targets; company targets are the default for company admins', async () => {
    const body = (extra: any = {}) => ({ type: 'sftp', name: 'NAS', path: 'pab', config: { host: 'nas.local', user: 'u' }, secrets: { pass: 'pw' }, ...extra })
    const carol = await login('carol@x.com')
    const mine = await api('POST', '/api/admin/backups/targets', carol, body(), cx(c2))
    expect(mine.statusCode, mine.body).toBe(201)
    expect(mine.json().scope).toBe('company')
    expect((await api('POST', '/api/admin/backups/targets', carol, body({ scope: 'system' }), cx(c2))).statusCode).toBe(403)
    expect((await api('POST', '/api/admin/backups/targets', carol, body({ scope: 'weird' }), cx(c2))).statusCode).toBe(400)
    const sys = await api('POST', '/api/admin/backups/targets', root, body({ name: 'Offsite', scope: 'system' }), cx(c2))
    expect(sys.statusCode, sys.body).toBe(201)
    expect(sys.json().scope).toBe('system')
    // the company admin cannot edit or delete the system one
    expect((await api('PUT', `/api/admin/backups/targets/${sys.json().id}`, carol, { name: 'x' }, cx(c2))).statusCode).toBe(403)
    expect((await api('DELETE', `/api/admin/backups/targets/${sys.json().id}`, carol, undefined, cx(c2))).statusCode).toBe(403)
    expect((await api('PUT', `/api/admin/backups/targets/${mine.json().id}`, carol, { scope: 'system' }, cx(c2))).statusCode).toBe(403)
    // targets.json tells backup.sh the scope and the company of every target
    const list = JSON.parse(readFileSync(path.join(rcloneDir, 'targets.json'), 'utf8'))
    expect(list.find((t: any) => t.id === mine.json().id)).toMatchObject({ scope: 'company', company_id: c2 })
    expect(list.find((t: any) => t.id === sys.json().id)).toMatchObject({ scope: 'system', company_id: c2 })
  })
})
