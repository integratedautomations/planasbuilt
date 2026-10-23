// Company admin: settings, storage, people, invites and password resets (everything here is scoped to the request's company).
import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from './db.js'
import type { Storage } from './storage.js'
import { validateS3Config } from './storage.js'
import type { Realtime } from './realtime.js'
import { mailerFor, smtpProblem } from './mail.js'
import { getSection, maskSection, mergeSection, putSection, renderInvite } from './settings.js'
import type { SectionName } from './settings.js'

import { isRole, normalizeScope, ROLES } from './roles.js'
import type { Cap, Role, Access } from './roles.js'
import { isCompanyRole } from './companies.js'
import type { CompanyCtx, CompanyRole } from './companies.js'
type Auth = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

export interface AdminContext {
  app: FastifyInstance
  db: Db
  auth: Auth
  /** Like auth, but also accepts a ?ft= file token (and the legacy ?token=): for GET file routes only. */
  fileAuth: Auth
  storage: Storage
  forgetUser: (id: string) => void
  requireCap: (req: FastifyRequest, reply: FastifyReply, projectId: string, cap: Cap) => Promise<Access | null>
  /** The request's company, checked against `min` (answers 403 and returns null otherwise). */
  requireCompany: (req: FastifyRequest, reply: FastifyReply, min?: CompanyRole) => Promise<CompanyCtx | null>
  /** A user's standing in a company given by id (the project's company, not the request's). */
  companyCtx: (user: { id: string; isAdmin: boolean }, companyId: string) => Promise<CompanyCtx | null>
  /** A person left a company (sockets, caches). */
  companyMemberRemoved: (userId: string, companyId: string) => Promise<void>
  sign: (u: { id: string; email: string; is_admin: boolean; token_version?: number }) => string
  realtime: Realtime
  /** Route options carrying the per-IP rate limit for unauthenticated endpoints. */
  rl: { config: { rateLimit: { max: number; timeWindow: string } } }
  keepsAnAdmin: (projectId: string, userId: string) => Promise<boolean>
  dropFromProject: (userId: string, projectId: string) => Promise<void>
  /** Pushes a changed role/scope to the person's open sockets. */
  refreshAccess: (userId: string, projectId: string) => Promise<void>
  /** The user as the app receives them at sign-in (is_admin = admin of their default company). */
  sessionUser: (u: any) => Promise<any>
  /** The site's public origin (PUBLIC_URL), or null when unset. Every emailed or returned link is built from it. */
  publicUrl: string | null
  /** Invite requests allowed per user per hour. */
  inviteRateLimitMax: number
  /** Re-reads the settings the server keeps in memory (session length, lockout, upload size). */
  reloadRuntime: () => Promise<void>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const INVITE_DAYS = 7, RESET_DAYS = 1
const LOGO_MAX = 1024 * 1024
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/svg+xml': 'svg' }
const SECTIONS: SectionName[] = ['company', 'tags', 'photos', 'retention', 'storage', 'smtp', 'security', 'uploads', 'invite', 'project_defaults']
/** Marks an invited account that has no password yet; never a valid bcrypt hash, so nobody can log in with it. */
const NO_PASSWORD = '!'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export async function registerAdmin(ctx: AdminContext) {
  const { app, db, auth, fileAuth, storage, forgetUser, requireCap, requireCompany, companyCtx, companyMemberRemoved, sign, realtime, rl, keepsAnAdmin, dropFromProject, refreshAccess, sessionUser, publicUrl, inviteRateLimitMax, reloadRuntime } = ctx

  /** Only an owner (or a platform admin) may create, change or remove another owner. */
  const mayTouchOwner = (c: CompanyCtx) => c.role === 'owner' || c.platform
  /**
   * Base of every invite / reset link: PUBLIC_URL when configured. Never the Origin header, which the client controls.
   * Without PUBLIC_URL it falls back to this request's Host (protocol from the trusted proxy), which only an authenticated
   * admin's own request can influence.
   */
  const linkBase = (req: FastifyRequest) => {
    if (publicUrl) return publicUrl
    const host = req.headers.host
    const plain = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/ // a bare host[:port], nothing that could carry a path or markup
    return `${req.protocol}://${typeof host === 'string' && plain.test(host) ? host : 'localhost'}`
  }
  // Creating or resending invites: per signed-in user, shared by the three routes that do it. The limiter runs after
  // authentication (preHandler) so it can key on the user.
  const inviteLimit = { config: { rateLimit: {
    max: inviteRateLimitMax, timeWindow: '1 hour', hook: 'preHandler' as const, groupId: 'invites',
    keyGenerator: (req: FastifyRequest) => `user:${req.user.id}`,
  } } }

  // ---- Company + public-to-members settings ----
  async function companyInfo(co: CompanyCtx) {
    const [c, tags, photos, smtp] = await Promise.all([
      getSection(db, co.id, 'company'), getSection(db, co.id, 'tags'), getSection(db, co.id, 'photos'), getSection(db, co.id, 'smtp')])
    return {
      id: co.id, name: c.name || co.name, address: c.address, phone: c.phone, prepared_by: c.prepared_by,
      has_logo: !!c.logo_key, logo_type: c.logo_type,
      tag_padding: tags.padding, photo_max_dimension: photos.max_dimension,
      email_enabled: !!mailerFor(smtp),
    }
  }

  app.get('/api/company', { preHandler: auth }, async (req, reply) => {
    const co = await requireCompany(req, reply)
    if (!co) return
    return companyInfo(co)
  })

  // Plain image URLs cannot send headers: pass ?company=<id> (and ?ft=) for a company other than the user's default.
  app.get('/api/company/logo', { preHandler: fileAuth }, async (req, reply) => {
    const co = await requireCompany(req, reply)
    if (!co) return
    const c = await getSection(db, co.id, 'company')
    const stream = c.logo_key ? await storage.open(c.logo_key) : null
    if (!stream) return reply.code(404).send({ error: 'No logo' })
    reply.header('Content-Type', c.logo_type || 'image/png')
    reply.header('Content-Disposition', `inline; filename="logo.${c.logo_type === 'image/svg+xml' ? 'svg' : 'png'}"`)
    // An SVG opened directly must not be able to run script on our origin.
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Cache-Control', 'private, no-cache')
    return reply.send(stream)
  })

  app.post('/api/settings/logo', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const file = await req.file({ limits: { fileSize: LOGO_MAX } })
    const ext = file && LOGO_TYPES[file.mimetype]
    if (!file || !ext) { file?.file.resume(); return reply.code(400).send({ error: 'The logo must be a PNG or SVG file' }) }
    const bytes = await file.toBuffer()
    if (file.file.truncated) return reply.code(413).send({ error: 'Logo too large (1 MB max)' })
    const looksRight = ext === 'png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : /^\s*(<\?xml|<!--|<!DOCTYPE svg|<svg)/i.test(bytes.subarray(0, 2000).toString('utf8').replace(/^\uFEFF/, ''))
    if (!looksRight) return reply.code(400).send({ error: 'That file is not a valid PNG or SVG' })
    const key = await storage.save(ext, bytes, company.id)
    const c = await getSection(db, company.id, 'company')
    await putSection(db, company.id, 'company', { ...c, logo_key: key, logo_type: file.mimetype })
    void storage.remove(c.logo_key)
    return companyInfo(company)
  })

  app.delete('/api/settings/logo', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const c = await getSection(db, company.id, 'company')
    await putSection(db, company.id, 'company', { ...c, logo_key: '', logo_type: '' })
    void storage.remove(c.logo_key)
    return companyInfo(company)
  })

  async function allSettings(companyId: string) {
    const out: Record<string, unknown> = {}
    for (const k of SECTIONS) out[k] = maskSection(k, await getSection(db, companyId, k))
    const company = out.company as any
    out.company = { ...company, has_logo: !!company.logo_key, logo_key: undefined }
    return out
  }

  app.get('/api/settings', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    return allSettings(company.id)
  })

  app.put('/api/settings', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const next: [SectionName, unknown][] = []
    for (const k of SECTIONS) {
      if (!(k in body)) continue
      const merged = mergeSection(k, await getSection(db, company.id, k), body[k])
      if ('error' in merged) return reply.code(400).send({ error: merged.error })
      if (k === 'storage' && merged.value.backend === 's3') {
        const problem = validateS3Config(merged.value.s3)
        if (problem) return reply.code(400).send({ error: problem })
      }
      if (k === 'smtp' && merged.value.host) {
        const problem = smtpProblem(merged.value)
        if (problem) return reply.code(400).send({ error: problem })
      }
      next.push([k, merged.value])
    }
    for (const [k, v] of next) await putSection(db, company.id, k, v)
    // The company's name is kept in step with its branding name.
    const named = next.find(([k]) => k === 'company')?.[1] as any
    if (named?.name) await db.query('UPDATE companies SET name = $2 WHERE id = $1', [company.id, named.name])
    await reloadRuntime()
    return allSettings(company.id)
  })

  app.post('/api/settings/test-email', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const to = String((req.body as any)?.to ?? '')
    if (!EMAIL_RE.test(to)) return reply.code(400).send({ error: 'Enter an email address to send the test to' })
    const mailer = mailerFor(await getSection(db, company.id, 'smtp'))
    if (!mailer) return reply.code(400).send({ error: 'Email is not configured. Fill in the SMTP settings and save first.' })
    try { await mailer.send({ to, subject: 'PlanAsBuilt test email', text: 'Email sending is working.' }) }
    catch (e) { return reply.code(400).send({ error: `Could not send: ${(e as Error).message}` }) }
    return { ok: true }
  })

  // ---- Storage ----
  app.post('/api/storage/test', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const stored = await getSection(db, company.id, 'storage')
    // Test what is on screen (unsaved), falling back to the saved secret when the form left it blank.
    const merged = mergeSection('storage', stored, { backend: 's3', s3: (req.body as any)?.s3 ?? {} })
    if ('error' in merged) return reply.code(400).send({ error: merged.error })
    try { await storage.testS3(merged.value.s3) }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }) }
    return { ok: true }
  })

  const isS3 = (key: string) => key.startsWith('s3:')

  app.get('/api/storage/usage', { preHandler: auth }, async (req, reply) => {
    const co = await requireCompany(req, reply, 'admin')
    if (!co) return
    let dbBytes: number | null = null
    try { dbBytes = Number((await db.query('SELECT pg_database_size(current_database()) AS n'))[0].n) } catch { /* unsupported */ }
    const plans = await db.query<{ project_id: string; file_key: string }>(
      `SELECT DISTINCT d.project_id, r.file_key FROM document_revisions r JOIN documents d ON d.id = r.document_id
       JOIN projects p ON p.id = d.project_id WHERE p.company_id = $1`, [co.id])
    const photos = await db.query<{ project_id: string; file_key: string }>(
      `SELECT DISTINCT d.project_id, k AS file_key FROM attachments a
       JOIN markups m ON m.id = a.markup_id JOIN documents d ON d.id = m.document_id JOIN projects p ON p.id = d.project_id,
       LATERAL (VALUES (a.file_key), (a.annotated_key)) AS v(k) WHERE k IS NOT NULL AND p.company_id = $1`, [co.id])
    const projects = await db.query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE company_id = $1 ORDER BY name', [co.id])
    const sizeCache = new Map<string, number>()
    const sizes = async (keys: string[]) => {
      const todo = [...new Set(keys)].filter(k => !sizeCache.has(k))
      for (let i = 0; i < todo.length; i += 8)
        await Promise.all(todo.slice(i, i + 8).map(async k => { sizeCache.set(k, (await storage.size(k).catch(() => null)) ?? 0) }))
    }
    await sizes([...plans, ...photos].map(r => r.file_key))
    const company = await getSection(db, co.id, 'company')
    if (company.logo_key) await sizes([company.logo_key])
    const sum = (rows: { file_key: string }[]) => rows.reduce((n, r) => n + (sizeCache.get(r.file_key) ?? 0), 0)
    const byProject = projects.map(p => {
      const pl = plans.filter(r => r.project_id === p.id), ph = photos.filter(r => r.project_id === p.id)
      const planBytes = sum(pl), photoBytes = sum(ph)
      return { id: p.id, name: p.name, plans_bytes: planBytes, photos_bytes: photoBytes, total_bytes: planBytes + photoBytes, file_count: pl.length + ph.length }
    }).sort((a, b) => b.total_bytes - a.total_bytes)
    const logoBytes = company.logo_key ? sizeCache.get(company.logo_key) ?? 0 : 0
    const uniqueKeys = new Set([...plans, ...photos].map(r => r.file_key).concat(company.logo_key ? [company.logo_key] : []))
    let local = 0, remote = 0
    for (const k of uniqueKeys) { if (isS3(k)) remote += sizeCache.get(k) ?? 0; else local += sizeCache.get(k) ?? 0 }
    return {
      db_bytes: dbBytes,
      files: {
        total_bytes: local + remote, local_bytes: local, s3_bytes: remote,
        categories: [
          { id: 'plans', label: 'Plans and revisions', bytes: sum(Array.from(new Map(plans.map(r => [r.file_key, r])).values())) },
          { id: 'photos', label: 'Photos', bytes: sum(Array.from(new Map(photos.map(r => [r.file_key, r])).values())) },
          { id: 'icons', label: 'Icons and logos', bytes: logoBytes },
        ],
      },
      projects: byProject,
    }
  })

  // Revision retention: keep every revision, or keep issued/restore revisions plus the newest N uploads.
  async function cleanupCandidates(companyId: string) {
    const ret = await getSection(db, companyId, 'retention')
    if (ret.mode !== 'keep') return { ret, rows: [] as any[], all: [] as any[] }
    const all = await db.query<any>(
      `SELECT r.id, r.revision, r.kind, r.label, r.file_key, r.created_at, d.id AS document_id, d.name AS document_name, p.name AS project_name,
              row_number() OVER (PARTITION BY r.document_id ORDER BY r.revision DESC) AS rn_all,
              row_number() OVER (PARTITION BY r.document_id, (r.kind = 'upload') ORDER BY r.revision DESC) AS rn_kind
       FROM document_revisions r JOIN documents d ON d.id = r.document_id JOIN projects p ON p.id = d.project_id
       WHERE p.company_id = $1
       ORDER BY p.name, d.name, r.revision`, [companyId])
    const rows = all.filter(r => r.kind === 'upload' && Number(r.rn_all) > 1 && Number(r.rn_kind) > ret.keep_latest)
    return { ret, rows, all }
  }

  async function cleanupPreview(companyId: string) {
    const { ret, rows, all } = await cleanupCandidates(companyId)
    const doomed = new Set(rows.map(r => r.id))
    const keptKeys = new Set(all.filter(r => !doomed.has(r.id)).map(r => r.file_key))
    const counted = new Set<string>()
    let reclaim = 0
    const candidates = []
    for (const r of rows) {
      const shared = keptKeys.has(r.file_key)
      let bytes = 0
      if (!shared && !counted.has(r.file_key)) { counted.add(r.file_key); bytes = (await storage.size(r.file_key).catch(() => null)) ?? 0 }
      reclaim += bytes
      candidates.push({
        id: r.id, project: r.project_name, document: r.document_name, revision: r.revision, label: r.label,
        created_at: r.created_at, bytes, file_kept: shared,
      })
    }
    return { mode: ret.mode, keep_latest: ret.keep_latest, candidates, reclaim_bytes: reclaim }
  }

  app.get('/api/storage/cleanup', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    return cleanupPreview(company.id)
  })

  app.post('/api/storage/cleanup', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const ids = (req.body as any)?.ids
    if (!Array.isArray(ids) || ids.some((i: unknown) => typeof i !== 'string' || !UUID_RE.test(i)))
      return reply.code(400).send({ error: 'ids must list the revisions to remove (see the preview)' })
    const { rows, all } = await cleanupCandidates(company.id)
    const want = new Set<string>(ids)
    const doomed = rows.filter(r => want.has(r.id))
    if (!doomed.length) return { removed: 0, freed_bytes: 0 }
    const doomedIds = new Set(doomed.map(r => r.id))
    const keptKeys = new Set(all.filter(r => !doomedIds.has(r.id)).map(r => r.file_key))
    const stillUsed = new Set((await db.query<{ k: string }>(
      'SELECT file_key AS k FROM attachments UNION SELECT annotated_key FROM attachments WHERE annotated_key IS NOT NULL')).map(r => r.k))
    await db.query('DELETE FROM document_revisions WHERE id = ANY($1::uuid[])', [[...doomedIds]])
    let freed = 0
    for (const key of new Set(doomed.map(r => r.file_key as string))) {
      if (keptKeys.has(key) || stillUsed.has(key)) continue
      freed += (await storage.size(key).catch(() => null)) ?? 0
      await storage.remove(key)
    }
    return { removed: doomed.length, freed_bytes: freed }
  })

  // ---- Own account ----
  app.patch('/api/me', { preHandler: auth }, async (req, reply) => {
    const name = String((req.body as any)?.name ?? '').trim().slice(0, 200)
    if (!name) return reply.code(400).send({ error: 'Name is required' })
    const [u] = await db.query('UPDATE users SET name = $1 WHERE id = $2 RETURNING id, email, name, is_admin', [name, req.user.id])
    return u
  })

  app.post('/api/me/password', { preHandler: auth }, async (req, reply) => {
    const { current, password } = (req.body ?? {}) as any
    if (typeof password !== 'string' || password.length < 8) return reply.code(400).send({ error: 'The new password must be at least 8 characters' })
    const [u] = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])
    if (!u || !(await bcrypt.compare(String(current ?? ''), u.password_hash))) return reply.code(400).send({ error: 'Your current password is wrong' })
    // Changing the password signs out every other session (token_version) and hands this one a fresh token.
    const [row] = await db.query(
      'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING id, email, is_admin, token_version',
      [await bcrypt.hash(password, 10), req.user.id])
    forgetUser(req.user.id)
    realtime.kickUser(req.user.id)
    return { ok: true, token: sign(row) }
  })

  // ---- People of the company ----
  // Accounts are global (one login, one email); what a company admin manages here is the person's place in THEIR company:
  // role, can_create_projects, projects. `is_admin` in these shapes is "owner or admin of this company"; platform_admin is
  // users.is_admin. Changes to the account itself (name, deactivation, password reset) are only for people who belong to no
  // other company, or for platform admins: otherwise one company's admin could lock a person out of another company.
  const USER_LIST_SQL = `
    SELECT u.id, u.email, u.name, (m.role IN ('owner','admin')) AS is_admin, u.is_admin AS platform_admin, m.role AS company_role,
      (m.can_create_projects OR m.role IN ('owner','admin')) AS can_create_projects, u.status, u.last_seen_at, u.created_at,
      (SELECT count(*)::int FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = u.id AND p.company_id = m.company_id) AS project_count,
      (SELECT t.expires_at FROM user_tokens t WHERE t.user_id = u.id AND t.purpose = 'invite' AND t.used_at IS NULL
         ORDER BY t.created_at DESC LIMIT 1) AS invite_expires_at
    FROM users u JOIN company_members m ON m.user_id = u.id AND m.company_id = $1`

  app.get('/api/users', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    return db.query(`${USER_LIST_SQL} ORDER BY lower(u.name), u.email`, [company.id])
  })

  // Names and emails of the active people of the company, for the "add existing user" picker on a project.
  app.get('/api/users/directory', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'member')
    if (!company) return
    return db.query(
      `SELECT u.id, u.email, u.name FROM users u JOIN company_members m ON m.user_id = u.id AND m.company_id = $1
       WHERE u.status = 'active' ORDER BY lower(u.name)`, [company.id])
  })

  // Every project of the company (the Users page lists it when assigning people).
  app.get('/api/projects/all', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    return db.query('SELECT id, name FROM projects WHERE company_id = $1 ORDER BY lower(name)', [company.id])
  })

  async function userDetail(companyId: string, id: string) {
    if (!UUID_RE.test(id)) return null
    const [u] = await db.query(`${USER_LIST_SQL} WHERE u.id = $2`, [companyId, id])
    if (!u) return null
    const projects = await db.query(
      `SELECT p.id, p.name, m.role FROM project_members m JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = $1 AND p.company_id = $2 ORDER BY p.name`, [id, companyId])
    return { ...u, projects }
  }

  app.get('/api/users/:id', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const u = await userDetail(company.id, (req.params as any).id)
    return u ?? reply.code(404).send({ error: 'Not found' })
  })

  async function otherActiveAdmins(companyId: string, exceptId: string) {
    return (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM company_members m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = $1 AND m.role IN ('owner','admin') AND u.status = 'active' AND u.id <> $2`, [companyId, exceptId]))[0].n
  }
  const otherOwners = async (companyId: string, exceptId: string) => (await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM company_members WHERE company_id = $1 AND role = 'owner' AND user_id <> $2", [companyId, exceptId]))[0].n
  const inOtherCompanies = async (userId: string, companyId: string) =>
    (await db.query('SELECT 1 FROM company_members WHERE user_id = $1 AND company_id <> $2 LIMIT 1', [userId, companyId])).length > 0

  // Body: name, status, is_admin (admin of this company), company_role, can_create_projects, platform_admin (platform admins only).
  app.patch('/api/users/:id', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const { id } = req.params as any
    const [u] = UUID_RE.test(id)
      ? await db.query(
        `SELECT u.*, m.role AS company_role, m.can_create_projects AS member_can_create FROM users u
         JOIN company_members m ON m.user_id = u.id AND m.company_id = $2 WHERE u.id = $1`, [id, company.id])
      : []
    if (!u) return reply.code(404).send({ error: 'Not found' })
    const b = (req.body ?? {}) as any
    const shared = await inOtherCompanies(id, company.id)
    const mayEditAccount = req.user.isAdmin || !shared
    let name = u.name, status = u.status, platform = !!u.is_admin
    let role: CompanyRole = u.company_role
    if ('name' in b) {
      if (!mayEditAccount) return reply.code(403).send({ error: 'This person belongs to other companies, so only they can change their name' })
      name = String(b.name ?? '').trim().slice(0, 200)
      if (!name) return reply.code(400).send({ error: 'Name is required' })
    }
    if ('is_admin' in b) {
      const wantAdmin = !!b.is_admin, isAdminNow = role === 'owner' || role === 'admin'
      if (wantAdmin && !isAdminNow) role = 'admin'
      if (!wantAdmin && isAdminNow) role = 'member'
    }
    if ('company_role' in b) {
      if (!isCompanyRole(b.company_role)) return reply.code(400).send({ error: 'Bad role' })
      role = b.company_role
    }
    if (role !== u.company_role && (role === 'owner' || u.company_role === 'owner') && !mayTouchOwner(company))
      return reply.code(403).send({ error: 'Only an owner can change an owner' })
    if ('platform_admin' in b) {
      if (!req.user.isAdmin) return reply.code(403).send({ error: 'Only a platform admin can change that' })
      platform = !!b.platform_admin
    }
    const canCreate = 'can_create_projects' in b ? !!b.can_create_projects : !!u.member_can_create
    if ('status' in b) {
      if (!['active', 'deactivated'].includes(b.status)) return reply.code(400).send({ error: 'Status must be active or deactivated' })
      if (u.status === 'invited') return reply.code(400).send({ error: 'This person has not accepted their invite yet. Revoke the invite instead.' })
      if (b.status !== u.status && !mayEditAccount) return reply.code(403).send({ error: 'This person belongs to other companies. Remove them from this company instead.' })
      status = b.status
    }
    const isAdminRole = (r: string) => r === 'owner' || r === 'admin'
    const self = id === req.user.id
    if (self && (status !== u.status || isAdminRole(role) !== isAdminRole(u.company_role) || platform !== !!u.is_admin))
      return reply.code(400).send({ error: 'You cannot change your own role or deactivate yourself' })
    const losingAdmin = isAdminRole(u.company_role) && u.status === 'active' && (!isAdminRole(role) || status !== 'active')
    if (losingAdmin && (await otherActiveAdmins(company.id, id)) === 0)
      return reply.code(400).send({ error: 'There must be at least one active admin' })
    if (u.company_role === 'owner' && role !== 'owner' && (await otherOwners(company.id, id)) === 0)
      return reply.code(400).send({ error: 'A company needs at least one owner' })
    if (u.is_admin && !platform && (await db.query("SELECT 1 FROM users WHERE is_admin AND status = 'active' AND id <> $1", [id])).length === 0)
      return reply.code(400).send({ error: 'There must be at least one platform admin' })
    // A role or status change signs the person out everywhere (their old tokens carry the old token_version).
    const bump = isAdminRole(role) !== isAdminRole(u.company_role) || status !== u.status || platform !== !!u.is_admin ? 1 : 0
    await db.transaction(async q => {
      await q('UPDATE users SET name = $1, is_admin = $2, status = $3, token_version = token_version + $5 WHERE id = $4', [name, platform, status, id, bump])
      await q('UPDATE company_members SET role = $3, can_create_projects = $4 WHERE company_id = $1 AND user_id = $2', [company.id, id, role, canCreate])
    })
    forgetUser(id)
    if (bump) realtime.kickUser(id)
    return userDetail(company.id, id)
  })

  app.put('/api/users/:id/projects', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const { id } = req.params as any
    const { project_id, role } = (req.body ?? {}) as any
    const [u] = UUID_RE.test(id)
      ? await db.query('SELECT user_id AS id FROM company_members WHERE user_id = $1 AND company_id = $2', [id, company.id]) : []
    if (!u) return reply.code(404).send({ error: 'Not found' })
    if (!UUID_RE.test(String(project_id)) || !(await db.query('SELECT 1 FROM projects WHERE id = $1 AND company_id = $2', [project_id, company.id])).length)
      return reply.code(400).send({ error: 'Unknown project' })
    if (role === null) {
      if (!(await keepsAnAdmin(project_id, id))) return reply.code(400).send({ error: 'A project needs at least one admin' })
      await db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [project_id, id])
      await dropFromProject(id, project_id)
    } else {
      if (!isRole(role)) return reply.code(400).send({ error: 'Bad role' })
      if (role !== 'admin' && !(await keepsAnAdmin(project_id, id))) return reply.code(400).send({ error: 'A project needs at least one admin' })
      const scope = role !== 'sub' ? normalizeScope(null) : (req.body as any).scope !== undefined ? normalizeScope((req.body as any).scope) : null
      await db.query(
        `INSERT INTO project_members (project_id, user_id, role, scope) VALUES ($1,$2,$3, coalesce($4::jsonb, '{"sets":[],"layers":[]}'::jsonb))
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role,
           scope = CASE WHEN $4::jsonb IS NULL THEN project_members.scope ELSE EXCLUDED.scope END`,
        [project_id, id, role, scope ? JSON.stringify(scope) : null])
      await refreshAccess(id, project_id)
    }
    return userDetail(company.id, id)
  })

  app.delete('/api/projects/:id/members/:userId', { preHandler: auth }, async (req, reply) => {
    const { id, userId } = req.params as any
    if (!(await requireCap(req, reply, id, 'members.manage'))) return
    if (!UUID_RE.test(String(userId))) return reply.code(404).send({ error: 'Not found' })
    if (!(await keepsAnAdmin(id, userId))) return reply.code(400).send({ error: 'A project needs at least one admin' })
    await db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [id, userId])
    await dropFromProject(userId, id)
    return { ok: true }
  })

  // ---- Invite and reset links ----
  async function makeToken(userId: string, purpose: 'invite' | 'reset', createdBy: string, companyId: string | null) {
    await db.query('DELETE FROM user_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose])
    const raw = randomBytes(32).toString('base64url')
    const days = purpose === 'invite' ? INVITE_DAYS : RESET_DAYS
    const [row] = await db.query(
      `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at, created_by, company_id)
       VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, $5, $6) RETURNING expires_at`,
      [userId, purpose, sha256(raw), String(days), createdBy, companyId])
    return { raw, expires_at: row.expires_at as string }
  }

  const linkFor = (origin: string, purpose: 'invite' | 'reset', raw: string) => `${origin}/${purpose === 'invite' ? 'invite' : 'reset'}/${raw}`

  /** Emails the link when the company has SMTP set up (its settings, its invite text). Never throws: the admin can always copy the link instead. */
  async function maybeEmail(companyId: string, to: string, purpose: 'invite' | 'reset', link: string, inviter: string, name = '') {
    const mailer = mailerFor(await getSection(db, companyId, 'smtp'))
    if (!mailer) return { emailed: false as const }
    const [co] = await db.query('SELECT name FROM companies WHERE id = $1', [companyId])
    const companyName = (await getSection(db, companyId, 'company')).name || co?.name || 'PlanAsBuilt'
    const tpl = await getSection(db, companyId, 'invite')
    const fill = renderInvite(tpl, { name, inviter: tpl.sender_name.trim() || inviter, company: companyName, link, days: String(INVITE_DAYS) })
    const text = purpose === 'invite'
      ? fill.body
      : `An admin reset your PlanAsBuilt password.\n\nChoose a new one here (valid for ${RESET_DAYS * 24} hours):\n${link}\n`
    try {
      await mailer.send({ to, subject: purpose === 'invite' ? fill.subject : 'Reset your PlanAsBuilt password', text })
      return { emailed: true as const }
    } catch (e) { return { emailed: false as const, email_error: (e as Error).message } }
  }

  interface InviteInput { email: string; name?: string; isAdmin: boolean; role?: unknown; projects: { id: string; role: Role }[] }

  /**
   * Invites someone into the company. A new email gets an account and a link. Someone who already has an account (here or in
   * another company) is added to the company straight away, with no second account and no link.
   */
  async function createInvite(req: FastifyRequest, reply: FastifyReply, company: CompanyCtx, input: InviteInput) {
    const email = input.email.trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'Enter a valid email address' })
    for (const p of input.projects) {
      if (!UUID_RE.test(String(p.id)) || !ROLES.includes(p.role)) return reply.code(400).send({ error: 'Bad project or role' })
      if (!(await db.query('SELECT 1 FROM projects WHERE id = $1 AND company_id = $2', [p.id, company.id])).length) return reply.code(400).send({ error: 'Unknown project' })
    }
    // Only a company admin picks the company role; a project admin's invite is always a plain member.
    const wanted: CompanyRole = company.isAdmin && isCompanyRole(input.role) && (input.role !== 'owner' || mayTouchOwner(company))
      ? input.role : company.isAdmin && input.isAdmin ? 'admin' : 'member'
    const [existing] = await db.query('SELECT id, status, name, invited_by FROM users WHERE email = $1', [email])
    if (existing?.status === 'deactivated')
      return reply.code(409).send({ error: 'That person has a deactivated account. A platform admin can reactivate them.' })
    const [member] = existing ? await db.query('SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2', [company.id, existing.id]) : []
    if (existing?.status === 'active' && member) return reply.code(409).send({ error: 'That person already has an account' })
    const name = (input.name ?? '').trim().slice(0, 200)
    const addProjects = async (userId: string) => {
      for (const p of input.projects)
        await db.query(`INSERT INTO project_members VALUES ($1,$2,$3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [p.id, userId, p.role])
    }
    const join = (userId: string, role: CompanyRole) => db.query(
      `INSERT INTO company_members (company_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, user_id) DO UPDATE SET role = CASE WHEN company_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END`, [company.id, userId, role])
    if (existing?.status === 'active') {
      await join(existing.id, wanted)
      await addProjects(existing.id)
      forgetUser(existing.id)
      return { user_id: existing.id, email, added_to_company: true, link: null, expires_at: null, emailed: false }
    }
    let userId: string
    if (existing) {
      userId = existing.id
      // Someone else's pending invite: a project admin, or an admin of another company, may add them to their own company and
      // projects but cannot touch the account or regenerate the link (that would let them set the password and take it over).
      const takeOver = req.user.isAdmin || existing.invited_by === req.user.id || (company.isAdmin && !!member)
      await join(userId, takeOver ? wanted : member ? member.role : 'member')
      if (!takeOver) {
        await addProjects(userId)
        return reply.code(409).send({ error: 'That person is already invited. They were added to this company; ask an admin to resend the invite.' })
      }
      await db.query('UPDATE users SET name = $1, invited_by = $2 WHERE id = $3', [name || existing.name, req.user.id, userId])
    } else {
      const [u] = await db.query(
        `INSERT INTO users (email, name, password_hash, is_admin, status, invited_by) VALUES ($1,$2,$3,false,'invited',$4) RETURNING id`,
        [email, name || email.split('@')[0], NO_PASSWORD, req.user.id])
      userId = u.id
      await join(userId, wanted)
    }
    await addProjects(userId)
    const t = await makeToken(userId, 'invite', req.user.id, company.id)
    const link = linkFor(linkBase(req), 'invite', t.raw)
    const [me] = await db.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    const mail = await maybeEmail(company.id, email, 'invite', link, me?.name ?? 'An admin', name || email.split('@')[0])
    return { user_id: userId, email, link, expires_at: t.expires_at, ...mail }
  }

  const cleanProjects = (v: unknown): { id: string; role: Role }[] =>
    (Array.isArray(v) ? v : []).filter(p => p && typeof p === 'object').map((p: any) => ({ id: String(p.id), role: p.role }))

  // Body: { email, name?, role?: 'admin' | 'user' | a company role, company_role?, projects?: [{ id, role }] }
  app.post('/api/invites', { preHandler: auth, ...inviteLimit }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const b = (req.body ?? {}) as any
    return createInvite(req, reply, company, {
      email: String(b.email ?? ''), name: b.name, isAdmin: b.role === 'admin', role: b.company_role ?? (isCompanyRole(b.role) ? b.role : undefined),
      projects: cleanProjects(b.projects),
    })
  })

  // A project admin can invite someone straight into their project (never as a company admin).
  app.post('/api/projects/:id/invites', { preHandler: auth, ...inviteLimit }, async (req, reply) => {
    const { id } = req.params as any
    const access = await requireCap(req, reply, id, 'members.manage')
    if (!access) return
    const company = await companyCtx(req.user, access.companyId!)
    if (!company) return reply.code(404).send({ error: 'Not found' })
    const b = (req.body ?? {}) as any
    return createInvite(req, reply, company, {
      email: String(b.email ?? ''), name: b.name, isAdmin: false, projects: [{ id, role: ROLES.includes(b.role) ? b.role : 'editor' }],
    })
  })

  app.post('/api/users/:id/invite', { preHandler: auth, ...inviteLimit }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const { id } = req.params as any
    const [u] = UUID_RE.test(id)
      ? await db.query(
        `SELECT u.id, u.email, u.name, u.status FROM users u JOIN company_members m ON m.user_id = u.id AND m.company_id = $2 WHERE u.id = $1`, [id, company.id]) : []
    if (!u || u.status !== 'invited') return reply.code(404).send({ error: 'No pending invite for that user' })
    const t = await makeToken(u.id, 'invite', req.user.id, company.id)
    const link = linkFor(linkBase(req), 'invite', t.raw)
    const [me] = await db.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    return { user_id: u.id, email: u.email, link, expires_at: t.expires_at, ...(await maybeEmail(company.id, u.email, 'invite', link, me?.name ?? 'An admin', u.name ?? '')) }
  })

  // Revoking takes the person out of this company (and its projects). The pending account itself is removed when no other
  // company still has them.
  app.delete('/api/users/:id/invite', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const { id } = req.params as any
    const [u] = UUID_RE.test(id)
      ? await db.query(
        `SELECT u.id, u.status FROM users u JOIN company_members m ON m.user_id = u.id AND m.company_id = $2 WHERE u.id = $1`, [id, company.id]) : []
    if (!u || u.status !== 'invited') return reply.code(404).send({ error: 'No pending invite for that user' })
    if (await inOtherCompanies(id, company.id)) {
      await db.transaction(async q => {
        await q('DELETE FROM project_members WHERE user_id = $2 AND project_id IN (SELECT id FROM projects WHERE company_id = $1)', [company.id, id])
        await q('DELETE FROM company_members WHERE company_id = $1 AND user_id = $2', [company.id, id])
        await q(`DELETE FROM user_tokens WHERE user_id = $2 AND purpose = 'invite' AND used_at IS NULL AND company_id = $1`, [company.id, id])
      })
      await companyMemberRemoved(id, company.id)
    } else {
      await db.query('DELETE FROM users WHERE id = $1', [id])
      forgetUser(id)
    }
    return { ok: true }
  })

  app.post('/api/users/:id/reset', { preHandler: auth }, async (req, reply) => {
    const company = await requireCompany(req, reply, 'admin')
    if (!company) return
    const { id } = req.params as any
    const [u] = UUID_RE.test(id)
      ? await db.query(
        `SELECT u.id, u.email, u.status FROM users u JOIN company_members m ON m.user_id = u.id AND m.company_id = $2 WHERE u.id = $1`, [id, company.id]) : []
    if (!u) return reply.code(404).send({ error: 'Not found' })
    if (u.status === 'invited') return reply.code(400).send({ error: 'This person has not accepted their invite yet. Resend the invite instead.' })
    if (!req.user.isAdmin && (await inOtherCompanies(id, company.id)))
      return reply.code(403).send({ error: 'This person belongs to other companies, so only they (or a platform admin) can reset their password' })
    const t = await makeToken(u.id, 'reset', req.user.id, company.id)
    const link = linkFor(linkBase(req), 'reset', t.raw)
    return { user_id: u.id, email: u.email, link, expires_at: t.expires_at, ...(await maybeEmail(company.id, u.email, 'reset', link, 'An admin')) }
  })

  // The invite / reset pages (public: the unguessable token is the credential).
  async function lookupToken(raw: string, purpose: 'invite' | 'reset') {
    const [t] = await db.query(
      `SELECT t.id, t.user_id, t.expires_at, t.used_at, t.expires_at < now() AS expired, u.email, u.name, u.status, inv.name AS inviter,
              (SELECT c.name FROM companies c WHERE c.id = coalesce(t.company_id,
                 (SELECT m.company_id FROM company_members m WHERE m.user_id = t.user_id ORDER BY m.created_at LIMIT 1))) AS company
       FROM user_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN users inv ON inv.id = t.created_by
       WHERE t.token_hash = $1 AND t.purpose = $2`, [sha256(String(raw)), purpose])
    return t as any
  }

  for (const purpose of ['invite', 'reset'] as const) {
    const base = purpose === 'invite' ? '/api/invites' : '/api/resets'
    const bad = (reply: FastifyReply, t: any) => {
      if (!t) return reply.code(404).send({ error: 'This link is not valid' })
      if (t.used_at) return reply.code(410).send({ error: 'This link has already been used' })
      if (t.expired) return reply.code(410).send({ error: 'This link has expired. Ask an admin for a new one.' })
      return null
    }

    app.get(`${base}/:token`, rl, async (req, reply) => {
      const t = await lookupToken((req.params as any).token, purpose)
      const err = bad(reply, t)
      if (err) return err
      return { purpose, email: t.email, name: t.name, inviter: t.inviter ?? null, company: t.company ?? '', expires_at: t.expires_at }
    })

    app.post(`${base}/:token/accept`, rl, async (req, reply) => {
      const t = await lookupToken((req.params as any).token, purpose)
      const err = bad(reply, t)
      if (err) return err
      const b = (req.body ?? {}) as any
      if (typeof b.password !== 'string' || b.password.length < 8) return reply.code(400).send({ error: 'Choose a password of at least 8 characters' })
      if (t.status === 'deactivated') return reply.code(403).send({ error: 'This account has been deactivated. Ask an admin.' })
      const name = purpose === 'invite' ? (String(b.name ?? '').trim().slice(0, 200) || t.name) : t.name
      const hash = await bcrypt.hash(b.password, 10)
      // Claim the token and set the password in one transaction: a link works exactly once even under concurrent requests.
      const user = await db.transaction(async q => {
        const [claimed] = await q('UPDATE user_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id', [t.id])
        if (!claimed) return null
        const [u] = await q(
          `UPDATE users SET password_hash = $1, name = $2, status = 'active', token_version = token_version + 1 WHERE id = $3
           RETURNING id, email, name, is_admin, token_version`, [hash, name, t.user_id])
        return u
      })
      if (!user) return reply.code(410).send({ error: 'This link has already been used' })
      forgetUser(user.id)
      realtime.kickUser(user.id)
      return { token: sign(user), user: await sessionUser(user) }
    })
  }

}
