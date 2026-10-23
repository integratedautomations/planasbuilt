// Project settings API (Phase 8c): the settings document and the project's report logo.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from './db.js'
import type { Access, Cap } from './roles.js'
import type { CompanyCtx, CompanyRole } from './companies.js'
import type { Storage } from './storage.js'
import { mergeProjectSettings, publicProjectSettings, readProjectSettings } from './projectSettings.js'
import { getSection } from './settings.js'

interface Ctx {
  app: any
  db: Db
  auth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  fileAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  storage: Storage
  requireCap: (req: FastifyRequest, reply: FastifyReply, projectId: string, cap: Cap) => Promise<Access | null>
  requireCompany: (req: FastifyRequest, reply: FastifyReply, min?: CompanyRole) => Promise<CompanyCtx | null>
  /** Deletes a stored file once nothing references it any more. */
  releaseFile: (key: string | null | undefined) => void
}

const LOGO_MAX = 2 * 1024 * 1024
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const logoKind = (b: Buffer): { ext: string; type: string } | null =>
  b.length > 8 && b.subarray(0, 8).equals(PNG) ? { ext: 'png', type: 'image/png' }
    : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? { ext: 'jpg', type: 'image/jpeg' } : null

export async function registerProjectSettings({ app, db, auth, fileAuth, storage, requireCap, releaseFile }: Ctx) {
  const load = async (id: string) => readProjectSettings((await db.query('SELECT settings FROM projects WHERE id = $1', [id]))[0]?.settings)
  const save = async (id: string, s: unknown) => { await db.query('UPDATE projects SET settings = $1 WHERE id = $2', [JSON.stringify(s), id]) }

  app.get('/api/projects/:id/settings', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'view'))) return
    return publicProjectSettings(await load(id))
  })

  // Project admins only. A partial body changes just the keys it names; statuses still used by devices cannot be removed.
  app.put('/api/projects/:id/settings', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any
    const access = await requireCap(req, reply, id, 'members.manage')
    if (!access) return
    const current = await load(id)
    const body = (req.body ?? {}) as Record<string, unknown>
    const inUse = 'statuses' in body
      ? (await db.query<{ status: string }>(
        `SELECT DISTINCT m.status FROM markups m JOIN documents d ON d.id = m.document_id
         WHERE d.project_id = $1 AND NOT m.deleted AND m.status <> ''`, [id])).map(r => r.status)
      : []
    const setIds = 'tag_prefixes' in body ? (await db.query<{ id: string }>('SELECT id FROM symbol_sets WHERE company_id = $1', [access.companyId])).map(r => r.id) : undefined
    const merged = mergeProjectSettings(current, body, { statusesInUse: inUse, setIds })
    if ('error' in merged) return reply.code(400).send({ error: merged.error })
    await save(id, merged.value)
    return publicProjectSettings(merged.value)
  })

  // The report logo: the project's own, else the organization's. 404 when neither exists.
  app.get('/api/projects/:id/logo', { preHandler: fileAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any
    const access = await requireCap(req, reply, id, 'view')
    if (!access) return
    const own = (await load(id)).report
    const org = own.logo_key ? null : await getSection(db, access.companyId!, 'company')
    const key = own.logo_key || org?.logo_key || ''
    const type = own.logo_key ? own.logo_type : org?.logo_type ?? ''
    const stream = key ? await storage.open(key) : null
    if (!stream) return reply.code(404).send({ error: 'No logo' })
    reply.header('Content-Type', type || 'image/png')
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Cache-Control', 'private, no-cache')
    return reply.send(stream)
  })

  app.post('/api/projects/:id/logo', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any
    const access = await requireCap(req, reply, id, 'members.manage')
    if (!access) return
    const file = await (req as any).file({ limits: { fileSize: LOGO_MAX } })
    if (!file) return reply.code(400).send({ error: 'No file' })
    const bytes: Buffer = await file.toBuffer()
    if (file.file.truncated) return reply.code(413).send({ error: 'Logo too large (2 MB max)' })
    const kind = logoKind(bytes)
    if (!kind) return reply.code(400).send({ error: 'The logo must be a PNG or JPEG image' })
    const key = await storage.save(kind.ext, bytes, access.companyId)
    const s = await load(id)
    const old = s.report.logo_key
    await save(id, { ...s, report: { ...s.report, logo_key: key, logo_type: kind.type } })
    releaseFile(old)
    return publicProjectSettings(await load(id))
  })

  app.delete('/api/projects/:id/logo', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'members.manage'))) return
    const s = await load(id)
    const old = s.report.logo_key
    await save(id, { ...s, report: { ...s.report, logo_key: '', logo_type: '' } })
    releaseFile(old)
    return publicProjectSettings(await load(id))
  })
}
