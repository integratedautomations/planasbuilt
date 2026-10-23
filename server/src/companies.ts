// Companies: one install serves several companies. People (users) are global; a company_members row says which companies
// a person belongs to and as what. Everything else (projects, catalog, settings) belongs to exactly one company.
//
//   owner / admin  manage the company's catalog, settings, people, storage and backups (owner: also other owners)
//   member         can be added to projects, and create projects when can_create_projects is on
//   guest          only the projects they are invited to, and the catalog without costs or internal fields
//
// users.is_admin means "platform admin": may create companies and enter any of them.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createCompanyRow, seedStarterCatalog } from './db.js'
import type { Db } from './db.js'
import type { Realtime } from './realtime.js'
import { getSection, maskSection } from './settings.js'
import type { SectionName } from './settings.js'
import { moveProject } from './projectMove.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import { companyFolder } from './fileLayout.js'

export const COMPANY_ROLES = ['owner', 'admin', 'member', 'guest'] as const
export type CompanyRole = (typeof COMPANY_ROLES)[number]
export const isCompanyRole = (v: unknown): v is CompanyRole => typeof v === 'string' && (COMPANY_ROLES as readonly string[]).includes(v)
export const roleRank: Record<CompanyRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 }

/** A user's standing in one company. */
export interface CompanyCtx {
  id: string
  name: string
  /** Their company role. A platform admin who is not a member acts as 'owner'. */
  role: CompanyRole
  /** A real company_members row exists. */
  member: boolean
  /** The user is a platform admin (users.is_admin). */
  platform: boolean
  /** Owner or admin of the company, or a platform admin. */
  isAdmin: boolean
  canCreateProjects: boolean
  archived: boolean
}

type Auth = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

export interface CompaniesContext {
  app: FastifyInstance
  db: Db
  auth: Auth
  requireCompany: (req: FastifyRequest, reply: FastifyReply, min?: CompanyRole) => Promise<CompanyCtx | null>
  /** The user's standing in a company given by id (not by the request), or null. */
  companyCtx: (user: { id: string; isAdmin: boolean }, companyId: string) => Promise<CompanyCtx | null>
  /** The company the request would work in, without answering an error. */
  resolveCompany: (req: FastifyRequest) => Promise<{ ctx: CompanyCtx } | { status: number; error: string }>
  forgetUser: (id: string) => void
  forgetCompany: (id: string) => void
  companyMemberRemoved: (userId: string, companyId: string) => Promise<void>
  reloadRuntime: () => Promise<void>
  realtime: Realtime
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECTIONS_FOR_EXPORT: SectionName[] = ['company', 'tags', 'photos', 'retention', 'storage', 'smtp', 'security', 'uploads', 'invite', 'project_defaults']

/** True when the request carries the install's internal backup token (compared in constant time). */
export function backupTokenOk(req: FastifyRequest, env: NodeJS.ProcessEnv = process.env): boolean {
  const want = (env.BACKUP_INTERNAL_TOKEN ?? '').trim()
  const got = req.headers['x-backup-token']
  if (want.length < 16 || typeof got !== 'string') return false
  const a = createHash('sha256').update(want).digest(), b = createHash('sha256').update(got).digest()
  return timingSafeEqual(a, b)
}

export async function registerCompanies(ctx: CompaniesContext) {
  const { app, db, auth, requireCompany, companyCtx, resolveCompany, forgetUser, forgetCompany, companyMemberRemoved, reloadRuntime, realtime } = ctx

  const view = (c: any, active: string | null) => ({
    id: c.id, name: c.name, slug: c.slug, archived: !!c.archived, created_at: c.created_at,
    role: (c.role ?? 'owner') as CompanyRole, member: !!c.role, can_create_projects: !!c.role ? !!c.can_create_projects || c.role === 'owner' || c.role === 'admin' : true,
    active: c.id === active,
    ...(c.member_count !== undefined ? { member_count: c.member_count } : {}),
  })

  /** Loads the path's company for an owner/admin of it (or a platform admin): 404 when not theirs, 403 when not an admin. */
  async function adminOf(req: FastifyRequest, reply: FastifyReply, companyId: string): Promise<CompanyCtx | null> {
    const c = await companyCtx(req.user, companyId)
    if (!c) { reply.code(404).send({ error: 'Not found' }); return null }
    if (!c.isAdmin) { reply.code(403).send({ error: 'Admins only' }); return null }
    return c
  }

  const listOne = async (userId: string, companyId: string, active: string | null) => {
    const [c] = await db.query(
      `SELECT c.id, c.name, c.slug, c.archived, c.created_at, m.role, m.can_create_projects,
         (SELECT count(*)::int FROM company_members x WHERE x.company_id = c.id) AS member_count
       FROM companies c LEFT JOIN company_members m ON m.company_id = c.id AND m.user_id = $2 WHERE c.id = $1`, [companyId, userId])
    return view(c, active)
  }

  // My companies. Platform admins get every company (they may enter any), the others the ones they belong to.
  // ?mine=1 limits a platform admin to their memberships; ?include_archived=1 adds archived companies.
  app.get('/api/companies', { preHandler: auth }, async (req) => {
    const q = (req.query ?? {}) as any
    const everything = req.user.isAdmin && q.mine !== '1' && q.mine !== 'true'
    const archived = q.include_archived === '1' || q.include_archived === 'true'
    const rows = await db.query(
      `SELECT c.id, c.name, c.slug, c.archived, c.created_at, m.role, m.can_create_projects,
         CASE WHEN $2::boolean OR m.role IN ('owner','admin') THEN (SELECT count(*)::int FROM company_members x WHERE x.company_id = c.id) END AS member_count
       FROM companies c LEFT JOIN company_members m ON m.company_id = c.id AND m.user_id = $1
       WHERE ($2::boolean OR m.user_id IS NOT NULL) AND ($3::boolean OR NOT c.archived) ORDER BY c.created_at, c.id`,
      [req.user.id, everything, archived])
    const r = await resolveCompany(req)
    const active = 'ctx' in r ? r.ctx.id : null
    return rows.map((c: any) => view({ ...c, member_count: c.member_count ?? undefined }, active))
  })

  // Platform admins create companies. The creator becomes its owner; owner_email (an existing person) may be added as a second owner.
  app.post('/api/companies', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Only a platform admin can create companies' })
    const b = (req.body ?? {}) as any
    const name = String(b.name ?? '').trim().slice(0, 200)
    if (!name) return reply.code(400).send({ error: 'Company name is required' })
    let ownerId: string | null = null
    if (b.owner_email) {
      const [o] = await db.query("SELECT id FROM users WHERE email = $1 AND status <> 'deactivated'", [String(b.owner_email).trim().toLowerCase()])
      if (!o) return reply.code(404).send({ error: 'No active user with that email' })
      ownerId = o.id
    }
    const company = await db.transaction(async q => {
      const c = await createCompanyRow(q, name)
      for (const id of new Set([req.user.id, ownerId].filter(Boolean) as string[]))
        await q(`INSERT INTO company_members (company_id, user_id, role, can_create_projects) VALUES ($1,$2,'owner',true)`, [c.id, id])
      if (b.seed_catalog === true) await seedStarterCatalog(q, c.id)
      return c
    })
    forgetUser(req.user.id)
    if (ownerId) forgetUser(ownerId)
    await reloadRuntime()
    return reply.code(201).send(await listOne(req.user.id, company.id, null))
  })

  app.get('/api/companies/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    const c = await companyCtx(req.user, id)
    if (!c) return reply.code(404).send({ error: 'Not found' })
    return listOne(req.user.id, id, null)
  })

  // Rename and/or archive (owner or admin of the company, or a platform admin). The name is also the company's branding name.
  app.patch('/api/companies/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    const c = await adminOf(req, reply, id)
    if (!c) return
    const b = (req.body ?? {}) as any
    if ('name' in b) {
      const name = String(b.name ?? '').trim().slice(0, 200)
      if (!name) return reply.code(400).send({ error: 'Company name is required' })
      await db.transaction(async q => {
        await q('UPDATE companies SET name = $2 WHERE id = $1', [id, name])
        await q(
          `INSERT INTO settings (company_id, key, value) VALUES ($1,'company',$2) ON CONFLICT (company_id, key)
           DO UPDATE SET value = jsonb_set(settings.value, '{name}', to_jsonb($3::text))`, [id, JSON.stringify({ name }), name])
      })
    }
    if ('archived' in b) {
      if (typeof b.archived !== 'boolean') return reply.code(400).send({ error: 'archived must be true or false' })
      await db.query('UPDATE companies SET archived = $2 WHERE id = $1', [id, b.archived])
    }
    forgetCompany(id)
    return listOne(req.user.id, id, null)
  })

  // ---- Members ----
  const MEMBERS_SQL = `
    SELECT u.id AS user_id, u.id, u.email, u.name, u.status, u.last_seen_at, u.is_admin AS platform_admin, m.role, m.can_create_projects, m.created_at AS joined_at
    FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1`

  app.get('/api/companies/:id/members', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await adminOf(req, reply, id))) return
    return db.query(`${MEMBERS_SQL} ORDER BY lower(u.name), u.email`, [id])
  })

  const owners = async (companyId: string, exceptUser?: string) =>
    (await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND m.role = 'owner' AND u.status <> 'deactivated' AND m.user_id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')",
      [companyId, exceptUser ?? null]))[0].n

  /** An admin may not create or change owners; only an owner (or a platform admin) may. */
  const mayTouchOwner = (actor: CompanyCtx) => actor.role === 'owner' || actor.platform

  // Adds an existing person to the company, or changes their role: { email | user_id, role, can_create_projects }.
  // New people are invited with POST /api/invites (they get a link and join this company when they accept).
  app.put('/api/companies/:id/members', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    const actor = await adminOf(req, reply, id)
    if (!actor) return
    const b = (req.body ?? {}) as any
    const role: CompanyRole = b.role === undefined ? 'member' : b.role
    if (!isCompanyRole(role)) return reply.code(400).send({ error: 'Bad role' })
    if (role === 'owner' && !mayTouchOwner(actor)) return reply.code(403).send({ error: 'Only an owner can make someone an owner' })
    const [user] = b.user_id && UUID_RE.test(String(b.user_id))
      ? await db.query("SELECT id, status FROM users WHERE id = $1 AND status <> 'deactivated'", [b.user_id])
      : await db.query("SELECT id, status FROM users WHERE email = $1 AND status <> 'deactivated'", [String(b.email ?? '').trim().toLowerCase()])
    if (!user) return reply.code(404).send({ error: 'No active user with that email' })
    const [cur] = await db.query('SELECT role, can_create_projects FROM company_members WHERE company_id = $1 AND user_id = $2', [id, user.id])
    if (cur?.role === 'owner' && role !== 'owner') {
      if (!mayTouchOwner(actor)) return reply.code(403).send({ error: 'Only an owner can change an owner' })
      if ((await owners(id, user.id)) === 0) return reply.code(400).send({ error: 'A company needs at least one owner' })
    }
    const canCreate = 'can_create_projects' in b ? !!b.can_create_projects : !!cur?.can_create_projects
    await db.query(
      `INSERT INTO company_members (company_id, user_id, role, can_create_projects) VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role, can_create_projects = EXCLUDED.can_create_projects`,
      [id, user.id, role, canCreate])
    forgetUser(user.id)
    return reply.code(cur ? 200 : 201).send((await db.query(`${MEMBERS_SQL} AND m.user_id = $2`, [id, user.id]))[0])
  })

  app.patch('/api/companies/:id/members/:userId', { preHandler: auth }, async (req, reply) => {
    const { id, userId } = req.params as any
    const actor = await adminOf(req, reply, id)
    if (!actor) return
    const [cur] = await db.query('SELECT role, can_create_projects FROM company_members WHERE company_id = $1 AND user_id = $2', [id, userId])
    if (!cur) return reply.code(404).send({ error: 'Not found' })
    const b = (req.body ?? {}) as any
    let role: CompanyRole = cur.role
    if ('role' in b) {
      if (!isCompanyRole(b.role)) return reply.code(400).send({ error: 'Bad role' })
      role = b.role
    }
    if ((role === 'owner' || cur.role === 'owner') && role !== cur.role && !mayTouchOwner(actor))
      return reply.code(403).send({ error: 'Only an owner can change an owner' })
    if (cur.role === 'owner' && role !== 'owner' && (await owners(id, userId)) === 0)
      return reply.code(400).send({ error: 'A company needs at least one owner' })
    await db.query('UPDATE company_members SET role = $3, can_create_projects = $4 WHERE company_id = $1 AND user_id = $2',
      [id, userId, role, 'can_create_projects' in b ? !!b.can_create_projects : cur.can_create_projects])
    forgetUser(userId)
    return (await db.query(`${MEMBERS_SQL} AND m.user_id = $2`, [id, userId]))[0]
  })

  /** Takes a person out of a company: their project memberships in it go too. The account itself stays. */
  async function removeMember(companyId: string, userId: string) {
    await db.transaction(async q => {
      await q('DELETE FROM project_members WHERE user_id = $2 AND project_id IN (SELECT id FROM projects WHERE company_id = $1)', [companyId, userId])
      await q('DELETE FROM company_members WHERE company_id = $1 AND user_id = $2', [companyId, userId])
      await q('UPDATE user_prefs SET last_company_id = NULL WHERE user_id = $2 AND last_company_id = $1', [companyId, userId])
    })
    await companyMemberRemoved(userId, companyId)
  }

  app.delete('/api/companies/:id/members/:userId', { preHandler: auth }, async (req, reply) => {
    const { id, userId } = req.params as any
    const actor = await adminOf(req, reply, id)
    if (!actor) return
    const [cur] = await db.query('SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2', [id, userId])
    if (!cur) return reply.code(404).send({ error: 'Not found' })
    if (cur.role === 'owner') {
      if (!mayTouchOwner(actor)) return reply.code(403).send({ error: 'Only an owner can remove an owner' })
      if ((await owners(id, userId)) === 0) return reply.code(400).send({ error: 'A company needs at least one owner' })
    }
    await removeMember(id, userId)
    return { ok: true }
  })

  // ---- Moving a project to another company (platform admins) ----
  // Symbol sets, device types, products and cable types its devices use are matched by name in the target company, or copied
  // over when missing. Project members who are not in the target company join it as guests so nobody loses access.
  app.post('/api/projects/:id/move', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Only a platform admin can move a project to another company' })
    const { id } = req.params as any
    const target = String((req.body as any)?.company_id ?? '')
    if (!UUID_RE.test(target)) return reply.code(400).send({ error: 'company_id is required' })
    const out = await moveProject(db, id, target)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    for (const uid of out.addedMembers) forgetUser(uid)
    const docs = await db.query<{ id: string }>('SELECT id FROM documents WHERE project_id = $1', [id])
    for (const d of docs) realtime.markupsReset(d.id, req.user.id, null)
    return out.summary
  })

  // ---- Per-company database export (JSON), the company's own rows only. Secrets are never included. ----
  // backup.sh calls this with the install's internal token (BACKUP_INTERNAL_TOKEN, shared by the app and backup containers) in the
  // X-Backup-Token header; the token is accepted on this route only. Everyone else needs to be an admin of the company.
  const exportAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (backupTokenOk(req)) { internalExport.add(req); return }
    return auth(req, reply)
  }
  const internalExport = new WeakSet<FastifyRequest>()
  app.get('/api/admin/companies/:id/export', { preHandler: exportAuth }, async (req, reply) => {
    const { id } = req.params as any
    if (!internalExport.has(req) && !(await adminOf(req, reply, id))) return
    const rows = (sql: string) => db.query(`SELECT to_jsonb(t) AS j FROM (${sql}) t`, [id]).then(r => r.map((x: any) => x.j))
    const pj = 'project_id IN (SELECT id FROM projects WHERE company_id = $1)'
    const doc = 'document_id IN (SELECT d.id FROM documents d JOIN projects p ON p.id = d.project_id WHERE p.company_id = $1)'
    const settings: Record<string, unknown> = {}
    for (const k of SECTIONS_FOR_EXPORT) settings[k] = maskSection(k, await getSection(db, id, k))
    return {
      exported_at: new Date().toISOString(),
      company: await rows('SELECT id, name, slug, archived, created_at FROM companies WHERE id = $1').then(r => r[0] && { ...r[0], folder: companyFolder(r[0].name) }),
      members: await rows('SELECT m.user_id, u.email, u.name, m.role, m.can_create_projects FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1'),
      settings,
      symbol_sets: await rows('SELECT * FROM symbol_sets WHERE company_id = $1'),
      device_types: await rows('SELECT * FROM device_types WHERE company_id = $1'),
      products: await rows('SELECT * FROM products WHERE company_id = $1'),
      cable_types: await rows('SELECT * FROM cable_types WHERE company_id = $1'),
      revu_mappings: await rows('SELECT * FROM revu_mappings WHERE company_id = $1'),
      projects: await rows('SELECT * FROM projects WHERE company_id = $1'),
      project_members: await rows(`SELECT * FROM project_members WHERE ${pj}`),
      layers: await rows(`SELECT * FROM layers WHERE ${pj}`),
      documents: await rows(`SELECT * FROM documents WHERE ${pj}`),
      document_revisions: await rows(`SELECT * FROM document_revisions WHERE ${doc}`),
      markups: await rows(`SELECT * FROM markups WHERE ${doc}`),
      attachments: await rows(`SELECT * FROM attachments WHERE markup_id IN (SELECT m.id FROM markups m WHERE m.${doc})`),
      page_scales: await rows(`SELECT * FROM page_scales WHERE ${doc}`),
    }
  })
}
