// File tools for admins and project members:
//   Organize files   POST /api/admin/storage/organize/preview | /apply, GET /api/admin/storage/organize/status
//                    (company owner/admin; scope "all" = every company and avatars, platform admin only)
//   Project folder   GET /api/projects/:id/folder.zip  (a project member who can view; the same layout as on disk)
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from './db.js'
import type { Storage } from './storage.js'
import type { Relayout } from './relayout.js'
import { planMoves } from './relayout.js'
import type { Access, Cap } from './roles.js'
import { canSeeMarkup } from './roles.js'
import type { CompanyCtx, CompanyRole } from './companies.js'
import { buildPath, sanitizeSegment, withSuffix } from './fileLayout.js'
import type { FileCtx } from './fileLayout.js'
import { projectNames } from './fileCtx.js'
import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, zipStream } from './zip.js'
import type { ZipEntry } from './zip.js'

type Auth = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

export interface FileToolsContext {
  app: FastifyInstance
  db: Db
  auth: Auth
  fileAuth: Auth
  storage: Storage
  relayout: Relayout
  requireCap: (req: FastifyRequest, reply: FastifyReply, projectId: string, cap: Cap) => Promise<Access | null>
  requireCompany: (req: FastifyRequest, reply: FastifyReply, min?: CompanyRole) => Promise<CompanyCtx | null>
  visibleMarkups: <T extends { symbol_set_id?: string | null; layer_id?: string | null; fields?: Record<string, any> }>(access: Access, list: T[]) => Promise<T[]>
}

const SAMPLES = 25
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}` // a spreadsheet must not run a cell as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function registerFileTools(ctx: FileToolsContext) {
  const { app, db, auth, fileAuth, storage, relayout, requireCap, requireCompany, visibleMarkups } = ctx

  /** The company the request works in, or "all companies" (platform admins only). Answers the error itself. */
  async function organizeScope(req: FastifyRequest, reply: FastifyReply): Promise<{ companyId: string | null } | null> {
    const wantAll = ((req.query as any)?.scope ?? (req.body as any)?.scope) === 'all'
    if (wantAll) {
      if (!req.user.isAdmin) { reply.code(403).send({ error: 'Only a platform admin can organize every company' }); return null }
      return { companyId: null }
    }
    const co = await requireCompany(req, reply, 'admin')
    return co ? { companyId: co.id } : null
  }

  app.post('/api/admin/storage/organize/preview', { preHandler: auth }, async (req, reply) => {
    const s = await organizeScope(req, reply)
    if (!s) return
    const plan = await planMoves(db, storage, s.companyId ? { type: 'company', id: s.companyId } : { type: 'all' }, { includeLegacy: true })
    const legacyMoves = plan.moves.filter(m => !m.from.includes('/')).length
    return {
      scope: s.companyId ? 'company' : 'all',
      files: plan.files,
      already_organized: plan.files - plan.moves.length,
      to_move: plan.moves.length,
      legacy_to_move: legacyMoves,
      samples: plan.moves.slice(0, SAMPLES).map(m => ({ from: m.from, to: m.to })),
    }
  })

  app.post('/api/admin/storage/organize/apply', { preHandler: auth }, async (req, reply) => {
    const s = await organizeScope(req, reply)
    if (!s) return
    const job = await relayout.enqueue('organize', s.companyId ? { type: 'company', id: s.companyId } : { type: 'all' }, req.user.id)
    // The background worker polls every few seconds; nudge it so the run starts now.
    if (relayout.started) setTimeout(() => { void relayout.run() }, 200).unref?.()
    return reply.code(202).send(await relayout.organizeStatus(s.companyId).then(st => ({ ...st, id: job.id })))
  })

  app.get('/api/admin/storage/organize/status', { preHandler: auth }, async (req, reply) => {
    const s = await organizeScope(req, reply)
    if (!s) return
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM relayout_jobs WHERE kind = 'relayout' AND status IN ('pending','running')")
    return { ...(await relayout.organizeStatus(s.companyId)), queued_renames: n }
  })

  // ---- Download project folder ----
  app.get('/api/projects/:id/folder.zip', { preHandler: fileAuth }, async (req, reply) => {
    const { id } = req.params as any
    const access = await requireCap(req, reply, id, 'view')
    if (!access) return
    const names = await projectNames(db, id)
    const root = sanitizeSegment(names.project, 'Project')
    const used = new Set<string>()
    const entries: ZipEntry[] = []
    let bytes = 0
    const seenKeys = new Set<string>()
    /** Adds a stored file at its layout path (below the project folder), skipping missing files and keys already added. */
    const addFile = async (key: string, c: FileCtx, mtime?: Date) => {
      if (!key || seenKeys.has(key)) return
      const size = await storage.size(key).catch(() => null)
      if (size === null) return
      seenKeys.add(key)
      // Layout paths are <Company>/Projects/<Project>/...: the zip starts at the project folder.
      let rel = `${root}/${buildPath({ ...c, ...names }).split('/').slice(3).join('/')}`
      for (let n = 1; ; n++) { const cand = withSuffix(rel, n); if (!used.has(cand.toLowerCase())) { rel = cand; break } }
      used.add(rel.toLowerCase())
      bytes += size
      entries.push({ name: rel, open: () => storage.open(key), mtime })
    }

    const plans = await db.query<any>(
      `SELECT r.file_key, r.revision, r.created_at, r.label, r.original_name, d.name AS plan
       FROM document_revisions r JOIN documents d ON d.id = r.document_id WHERE d.project_id = $1 ORDER BY d.name, d.id, r.revision`, [id])
    for (const r of plans)
      await addFile(r.file_key, { kind: 'plan', ext: r.file_key.slice(r.file_key.lastIndexOf('.') + 1), plan: r.plan, rev: r.revision, at: r.created_at, original: r.original_name || r.label || '' }, new Date(r.created_at))

    const photos = await db.query<any>(
      `SELECT a.file_key, a.annotated_key, a.caption, a.created_at, m.tag, m.symbol_set_id, m.layer_id, dt.name AS device_type, d.name AS plan
       FROM attachments a JOIN markups m ON m.id = a.markup_id JOIN documents d ON d.id = m.document_id
       LEFT JOIN device_types dt ON dt.id = m.device_type_id
       WHERE d.project_id = $1 AND NOT m.deleted ORDER BY d.name, m.tag, a.created_at, a.id`, [id])
    for (const r of photos) {
      if (!canSeeMarkup(access, r)) continue
      const c = { plan: r.plan, tag: r.tag, deviceType: r.device_type, caption: r.caption, at: r.created_at }
      await addFile(r.file_key, { kind: 'photo', ext: r.file_key.slice(r.file_key.lastIndexOf('.') + 1), ...c }, new Date(r.created_at))
      if (r.annotated_key) await addFile(r.annotated_key, { kind: 'annotated', ext: r.annotated_key.slice(r.annotated_key.lastIndexOf('.') + 1), ...c }, new Date(r.created_at))
    }

    const [proj] = await db.query<any>("SELECT settings->'report'->>'logo_key' AS logo FROM projects WHERE id = $1", [id])
    if (proj?.logo) await addFile(proj.logo, { kind: 'project-logo', ext: proj.logo.slice(proj.logo.lastIndexOf('.') + 1) })

    // The device list: what a project member may see (a sub only their scope, internal fields stripped for clients), no costs.
    const rows = await db.query<any>(
      `SELECT m.id, m.page, m.tag, m.status, m.text, m.fields, m.symbol_set_id, m.layer_id, d.name AS plan, ss.name AS symbol_set, dt.name AS device_type,
              pr.manufacturer, pr.model, (SELECT count(*)::int FROM attachments a WHERE a.markup_id = m.id) AS photos
       FROM markups m JOIN documents d ON d.id = m.document_id
       LEFT JOIN symbol_sets ss ON ss.id = m.symbol_set_id LEFT JOIN device_types dt ON dt.id = m.device_type_id LEFT JOIN products pr ON pr.id = m.product_id
       WHERE d.project_id = $1 AND NOT m.deleted AND m.symbol_set_id IS NOT NULL ORDER BY d.name, m.page, m.tag, m.id`, [id])
    const devices = (await visibleMarkups(access, rows)).map((r: any) => ({
      plan: r.plan, page: r.page, tag: r.tag, symbol_set: r.symbol_set, device_type: r.device_type, status: r.status,
      manufacturer: r.manufacturer, model: r.model, notes: r.text, photos: r.photos, fields: r.fields ?? {},
    }))
    const fieldKeys = [...new Set(devices.flatMap(d => Object.keys(d.fields)))].sort()
    const head = ['plan', 'page', 'tag', 'symbol_set', 'device_type', 'status', 'manufacturer', 'model', 'notes', 'photos', ...fieldKeys]
    const csv = '﻿' + [head, ...devices.map(d => [d.plan, d.page, d.tag, d.symbol_set, d.device_type, d.status, d.manufacturer, d.model, d.notes, d.photos, ...fieldKeys.map(k => d.fields[k])])]
      .map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
    entries.push({ name: `${root}/devices.csv`, data: csv }, { name: `${root}/devices.json`, data: JSON.stringify({ project: names.project, company: names.company, exported_at: new Date().toISOString(), devices }, null, 2) })

    if (bytes > ZIP_MAX_BYTES || entries.length > ZIP_MAX_ENTRIES)
      return reply.code(413).send({ error: 'This project is too large for a single zip download (4 GB or 65,000 files). Copy the folder from the file share instead.' })

    const fileName = `${root}.zip`
    reply.header('Content-Type', 'application/zip')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._ -]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    reply.header('Cache-Control', 'private, no-store')
    return reply.send(zipStream(entries))
  })
}
