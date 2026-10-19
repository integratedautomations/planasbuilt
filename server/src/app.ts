import { createReadStream, createWriteStream, existsSync, mkdirSync, unlink } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import Fastify, { FastifyReply, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import bcrypt from 'bcryptjs'
import { Db } from './db.js'

export type Role = 'admin' | 'editor' | 'viewer'
const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 }

interface AuthUser { id: string; email: string; isAdmin: boolean }

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: AuthUser; user: AuthUser }
}

export interface AppOptions {
  db: Db
  jwtSecret: string
  filesDir: string
  webDir?: string
}

export async function buildApp({ db, jwtSecret, filesDir, webDir }: AppOptions) {
  mkdirSync(filesDir, { recursive: true })
  const app = Fastify({ logger: false })
  await app.register(cors)
  await app.register(jwt, { secret: jwtSecret })
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })

  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // Allow ?token= so plain file URLs (pdf.js, downloads) can authenticate
      const q = (req.query as any)?.token
      if (q && !req.headers.authorization) req.headers.authorization = `Bearer ${q}`
      await req.jwtVerify()
    } catch {
      return reply.code(401).send({ error: 'Not signed in' })
    }
  }

  const sign = (u: { id: string; email: string; is_admin: boolean }) =>
    app.jwt.sign({ id: u.id, email: u.email, isAdmin: u.is_admin }, { expiresIn: '30d' })

  const userCount = async () =>
    (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM users'))[0].count

  async function projectRole(userId: string, projectId: string): Promise<Role | null> {
    const rows = await db.query<{ role: Role }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId])
    return rows[0]?.role ?? null
  }

  async function requireRole(req: FastifyRequest, reply: FastifyReply, projectId: string, min: Role) {
    const role = await projectRole(req.user.id, projectId)
    if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
      reply.code(403).send({ error: 'Not allowed' })
      return null
    }
    return role
  }

  function validNewUser(body: any) {
    const { email, name, password } = body ?? {}
    return email && name && typeof password === 'string' && password.length >= 8
  }

  // ---- Auth ----
  app.get('/api/auth/status', async () => ({ needsSetup: (await userCount()) === 0 }))

  // First user only: creates the initial admin. Later users are added by an admin.
  app.post('/api/auth/setup', async (req, reply) => {
    if ((await userCount()) > 0) return reply.code(409).send({ error: 'Already set up' })
    if (!validNewUser(req.body))
      return reply.code(400).send({ error: 'Email, name and an 8+ character password are required' })
    const { email, name, password } = req.body as any
    const [user] = await db.query(
      'INSERT INTO users (email, name, password_hash, is_admin) VALUES ($1,$2,$3,true) RETURNING id, email, name, is_admin',
      [String(email).toLowerCase(), name, await bcrypt.hash(password, 10)])
    return { token: sign(user), user }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as any
    const [user] = await db.query('SELECT * FROM users WHERE email = $1', [String(email ?? '').toLowerCase()])
    if (!user || !(await bcrypt.compare(String(password ?? ''), user.password_hash)))
      return reply.code(401).send({ error: 'Wrong email or password' })
    return { token: sign(user), user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin } }
  })

  app.get('/api/me', { preHandler: auth }, async (req) => {
    const [user] = await db.query('SELECT id, email, name, is_admin FROM users WHERE id = $1', [req.user.id])
    return user
  })

  // ---- Users (app admins) ----
  app.get('/api/users', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    return db.query('SELECT id, email, name, is_admin FROM users ORDER BY name')
  })

  app.post('/api/users', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    if (!validNewUser(req.body))
      return reply.code(400).send({ error: 'Email, name and an 8+ character password are required' })
    const { email, name, password, isAdmin } = req.body as any
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [String(email).toLowerCase()])
    if (exists.length) return reply.code(409).send({ error: 'Email already in use' })
    const [user] = await db.query(
      'INSERT INTO users (email, name, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING id, email, name, is_admin',
      [String(email).toLowerCase(), name, await bcrypt.hash(password, 10), !!isAdmin])
    return user
  })

  // ---- Projects ----
  app.get('/api/projects', { preHandler: auth }, async (req) =>
    db.query(
      `SELECT p.id, p.name, p.created_at, m.role,
         (SELECT count(*)::int FROM documents d WHERE d.project_id = p.id) AS document_count
       FROM projects p JOIN project_members m ON m.project_id = p.id
       WHERE m.user_id = $1 ORDER BY p.created_at DESC`, [req.user.id]))

  app.post('/api/projects', { preHandler: auth }, async (req, reply) => {
    const name = String((req.body as any)?.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'Project name is required' })
    const [project] = await db.query(
      'INSERT INTO projects (name, created_by) VALUES ($1,$2) RETURNING *', [name, req.user.id])
    await db.query('INSERT INTO project_members VALUES ($1,$2,$3)', [project.id, req.user.id, 'admin'])
    return { ...project, role: 'admin' }
  })

  app.get('/api/projects/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    const role = await requireRole(req, reply, id, 'viewer')
    if (!role) return
    const [project] = await db.query('SELECT * FROM projects WHERE id = $1', [id])
    return { ...project, role }
  })

  app.get('/api/projects/:id/members', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireRole(req, reply, id, 'viewer'))) return
    return db.query(
      `SELECT u.id, u.email, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 ORDER BY u.name`, [id])
  })

  app.put('/api/projects/:id/members', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireRole(req, reply, id, 'admin'))) return
    const { email, role } = (req.body ?? {}) as any
    if (!['admin', 'editor', 'viewer'].includes(role)) return reply.code(400).send({ error: 'Bad role' })
    const [user] = await db.query('SELECT id FROM users WHERE email = $1', [String(email ?? '').toLowerCase()])
    if (!user) return reply.code(404).send({ error: 'No user with that email' })
    await db.query(
      `INSERT INTO project_members VALUES ($1,$2,$3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [id, user.id, role])
    return { ok: true }
  })

  // ---- Documents ----
  app.get('/api/projects/:id/documents', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireRole(req, reply, id, 'viewer'))) return
    return db.query(
      `SELECT d.id, d.name, d.created_at, r.id AS revision_id, r.revision, r.page_count
       FROM documents d
       JOIN LATERAL (SELECT * FROM document_revisions WHERE document_id = d.id ORDER BY revision DESC LIMIT 1) r ON true
       WHERE d.project_id = $1 ORDER BY d.name`, [id])
  })

  app.post('/api/projects/:id/documents', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireRole(req, reply, id, 'editor'))) return
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: 'No file' })
    if (file.mimetype !== 'application/pdf' && !file.filename.toLowerCase().endsWith('.pdf'))
      return reply.code(400).send({ error: 'Only PDF files are supported' })
    const fileKey = `${randomUUID()}.pdf`
    await pipeline(file.file, createWriteStream(path.join(filesDir, fileKey)))
    if (file.file.truncated) return reply.code(413).send({ error: 'File too large' })
    const fields = file.fields as any
    const pageCount = Number(fields.pageCount?.value) || 1
    const name = String(fields.name?.value || file.filename.replace(/\.pdf$/i, ''))
    const [doc] = await db.query('INSERT INTO documents (project_id, name) VALUES ($1,$2) RETURNING *', [id, name])
    const [rev] = await db.query(
      `INSERT INTO document_revisions (document_id, revision, file_key, page_count, uploaded_by)
       VALUES ($1, 1, $2, $3, $4) RETURNING *`, [doc.id, fileKey, pageCount, req.user.id])
    return { id: doc.id, name: doc.name, created_at: doc.created_at, revision_id: rev.id, revision: 1, page_count: pageCount }
  })

  async function documentWithAccess(req: FastifyRequest, reply: FastifyReply, min: Role) {
    const { id } = req.params as any
    const [doc] = await db.query('SELECT * FROM documents WHERE id = $1', [id])
    if (!doc) { reply.code(404).send({ error: 'Not found' }); return null }
    if (!(await requireRole(req, reply, doc.project_id, min))) return null
    return doc
  }

  app.get('/api/documents/:id', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'viewer')
    if (!doc) return
    const revisions = await db.query(
      'SELECT id, revision, page_count, created_at FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC', [doc.id])
    return { ...doc, revisions }
  })

  app.patch('/api/documents/:id', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'editor')
    if (!doc) return
    const name = String((req.body as any)?.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'Name is required' })
    const [updated] = await db.query('UPDATE documents SET name = $1 WHERE id = $2 RETURNING *', [name, doc.id])
    return updated
  })

  app.delete('/api/documents/:id', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'admin')
    if (!doc) return
    await db.query('DELETE FROM documents WHERE id = $1', [doc.id])
    return { ok: true }
  })

  app.get('/api/documents/:id/file', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'viewer')
    if (!doc) return
    const [rev] = await db.query(
      'SELECT file_key FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
    const filePath = path.join(filesDir, rev.file_key)
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'File missing' })
    reply.header('Content-Type', 'application/pdf')
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    return reply.send(createReadStream(filePath))
  })

  // ---- Layers ----
  app.get('/api/projects/:id/layers', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireRole(req, reply, id, 'viewer'))) return
    return db.query('SELECT * FROM layers WHERE project_id = $1 ORDER BY sort, created_at', [id])
  })

  app.post('/api/projects/:id/layers', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireRole(req, reply, id, 'editor'))) return
    const { name, color } = (req.body ?? {}) as any
    if (!String(name ?? '').trim()) return reply.code(400).send({ error: 'Layer name is required' })
    const [layer] = await db.query(
      `INSERT INTO layers (project_id, name, color, sort)
       VALUES ($1, $2, $3, (SELECT coalesce(max(sort), 0) + 1 FROM layers WHERE project_id = $1)) RETURNING *`,
      [id, String(name).trim(), color || '#e8590c'])
    return layer
  })

  async function layerWithAccess(req: FastifyRequest, reply: FastifyReply, min: Role) {
    const { id } = req.params as any
    const [layer] = await db.query('SELECT * FROM layers WHERE id = $1', [id])
    if (!layer) { reply.code(404).send({ error: 'Not found' }); return null }
    if (!(await requireRole(req, reply, layer.project_id, min))) return null
    return layer
  }

  app.patch('/api/layers/:id', { preHandler: auth }, async (req, reply) => {
    const layer = await layerWithAccess(req, reply, 'editor')
    if (!layer) return
    const { name, color } = (req.body ?? {}) as any
    const [updated] = await db.query(
      'UPDATE layers SET name = $1, color = $2 WHERE id = $3 RETURNING *',
      [String(name ?? layer.name).trim() || layer.name, color ?? layer.color, layer.id])
    return updated
  })

  app.delete('/api/layers/:id', { preHandler: auth }, async (req, reply) => {
    const layer = await layerWithAccess(req, reply, 'admin')
    if (!layer) return
    await db.query('DELETE FROM layers WHERE id = $1', [layer.id])
    return { ok: true }
  })

  // ---- Symbol sets (shared by the whole team; app admins edit) ----
  const FIELD_TYPES = ['text', 'number', 'select', 'ip', 'date', 'checkbox']
  function cleanSymbolSet(b: any) {
    const name = String(b?.name ?? '').trim()
    const tag_prefix = String(b?.tag_prefix ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!name || !tag_prefix) return null
    const fields = Array.isArray(b.fields) ? b.fields
      .filter((f: any) => f && String(f.label ?? '').trim() && FIELD_TYPES.includes(f.type))
      .map((f: any) => ({
        key: String(f.key || f.label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        label: String(f.label).trim(),
        type: f.type,
        ...(f.type === 'select' ? { options: (Array.isArray(f.options) ? f.options : []).map(String).filter(Boolean) } : {}),
      })) : []
    const icon = String(b.icon ?? '')
    if (icon && !/^data:image\/(svg\+xml|png|jpeg|webp)[;,]/.test(icon)) return null
    if (icon.length > 300_000) return null
    return { name, tag_prefix, fields, icon, color: String(b.color || '#868e96'), has_fov: !!b.has_fov }
  }

  app.get('/api/symbol-sets', { preHandler: auth }, async () =>
    db.query('SELECT * FROM symbol_sets WHERE NOT archived ORDER BY sort, created_at'))

  app.post('/api/symbol-sets', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const s = cleanSymbolSet(req.body)
    if (!s) return reply.code(400).send({ error: 'Name, tag prefix and a valid icon are required' })
    const [row] = await db.query(
      `INSERT INTO symbol_sets (name, color, tag_prefix, icon, fields, has_fov, sort)
       VALUES ($1,$2,$3,$4,$5,$6,(SELECT coalesce(max(sort),0)+1 FROM symbol_sets)) RETURNING *`,
      [s.name, s.color, s.tag_prefix, s.icon, JSON.stringify(s.fields), s.has_fov])
    return row
  })

  app.put('/api/symbol-sets/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const s = cleanSymbolSet(req.body)
    if (!s) return reply.code(400).send({ error: 'Name, tag prefix and a valid icon are required' })
    const [row] = await db.query(
      `UPDATE symbol_sets SET name=$1, color=$2, tag_prefix=$3, icon=$4, fields=$5, has_fov=$6 WHERE id=$7 RETURNING *`,
      [s.name, s.color, s.tag_prefix, s.icon, JSON.stringify(s.fields), s.has_fov, (req.params as any).id])
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return row
  })

  // Archive rather than delete so existing device markups keep their set
  app.delete('/api/symbol-sets/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    await db.query('UPDATE symbol_sets SET archived = true WHERE id = $1', [(req.params as any).id])
    return { ok: true }
  })

  /** Next free tag for a prefix across the whole project, e.g. CAM-07. */
  async function nextTag(projectId: string, prefix: string) {
    const rows = await db.query<{ tag: string }>(
      `SELECT m.tag FROM markups m JOIN documents d ON d.id = m.document_id
       WHERE d.project_id = $1 AND NOT m.deleted AND m.tag LIKE $2`, [projectId, `${prefix}-%`])
    const max = rows.reduce((n, r) => {
      const k = Number(r.tag.slice(prefix.length + 1))
      return Number.isInteger(k) && k > n ? k : n
    }, 0)
    return `${prefix}-${String(max + 1).padStart(2, '0')}`
  }

  // ---- Markups ----
  const MARKUP_COLUMNS = 'id, document_id, page, type, geometry, style, text, layer_id, symbol_set_id, tag, status, fields, version, created_by, updated_by, created_at, updated_at'
  const STATUSES = ['', 'planned', 'installed', 'tested', 'punch']

  app.get('/api/documents/:id/markups', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'viewer')
    if (!doc) return
    return db.query(`SELECT ${MARKUP_COLUMNS} FROM markups WHERE document_id = $1 AND NOT deleted ORDER BY created_at`, [doc.id])
  })

  // Upsert by client-generated id. Last write wins; version increases on every save.
  app.put('/api/documents/:id/markups/:markupId', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'editor')
    if (!doc) return
    const { markupId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!/^[0-9a-f-]{36}$/i.test(markupId)) return reply.code(400).send({ error: 'Bad markup id' })
    if (!b.type || !b.geometry || !Number.isInteger(b.page) || b.page < 1)
      return reply.code(400).send({ error: 'type, page and geometry are required' })
    const [existing] = await db.query('SELECT document_id FROM markups WHERE id = $1', [markupId])
    if (existing && existing.document_id !== doc.id) return reply.code(409).send({ error: 'Markup belongs to another document' })
    if (b.layer_id) {
      const [layer] = await db.query('SELECT project_id FROM layers WHERE id = $1', [b.layer_id])
      if (!layer || layer.project_id !== doc.project_id) return reply.code(400).send({ error: 'Unknown layer' })
    }
    const status = String(b.status ?? '')
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: 'Bad status' })
    let tag = String(b.tag ?? '').trim()
    if (b.symbol_set_id) {
      const [set] = await db.query('SELECT tag_prefix FROM symbol_sets WHERE id = $1', [b.symbol_set_id])
      if (!set) return reply.code(400).send({ error: 'Unknown symbol set' })
      if (!tag) tag = await nextTag(doc.project_id, set.tag_prefix)
    }
    const fields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : {}
    const [row] = await db.query(
      `INSERT INTO markups (id, document_id, page, type, geometry, style, text, layer_id, symbol_set_id, tag, status, fields, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       ON CONFLICT (id) DO UPDATE SET page = EXCLUDED.page, type = EXCLUDED.type, geometry = EXCLUDED.geometry,
         style = EXCLUDED.style, text = EXCLUDED.text, layer_id = EXCLUDED.layer_id,
         symbol_set_id = EXCLUDED.symbol_set_id, tag = EXCLUDED.tag, status = EXCLUDED.status, fields = EXCLUDED.fields,
         deleted = false, version = markups.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${MARKUP_COLUMNS}`,
      [markupId, doc.id, b.page, String(b.type), JSON.stringify(b.geometry), JSON.stringify(b.style ?? {}),
        String(b.text ?? ''), b.layer_id || null, b.symbol_set_id || null, tag, status, JSON.stringify(fields), req.user.id])
    return row
  })

  app.delete('/api/documents/:id/markups/:markupId', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'editor')
    if (!doc) return
    const { markupId } = req.params as any
    await db.query(
      `UPDATE markups SET deleted = true, version = version + 1, updated_by = $1, updated_at = now()
       WHERE id = $2 AND document_id = $3`, [req.user.id, markupId, doc.id])
    return { ok: true }
  })

  // ---- Photo attachments (belong to markups) ----
  const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  const EXT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
  const PHOTO_MAX = 15 * 1024 * 1024
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const ATT_COLUMNS = 'id, markup_id, caption, width, height, created_at, created_by, (annotated_key IS NOT NULL) AS has_annotation'

  const removeFile = (key: string | null | undefined) => {
    if (key) unlink(path.join(filesDir, path.basename(key)), () => {})
  }
  const optInt = (v: unknown) => {
    const n = Number(v)
    return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 && n < 100000 ? n : null
  }

  async function markupWithAccess(req: FastifyRequest, reply: FastifyReply, min: Role) {
    const { markupId } = req.params as any
    if (!UUID_RE.test(String(markupId))) { reply.code(404).send({ error: 'Not found' }); return null }
    const [m] = await db.query(
      'SELECT m.*, d.project_id FROM markups m JOIN documents d ON d.id = m.document_id WHERE m.id = $1', [markupId])
    if (!m || m.deleted) { reply.code(404).send({ error: 'Not found' }); return null }
    if (!(await requireRole(req, reply, m.project_id, min))) return null
    return m
  }

  async function attachmentWithAccess(req: FastifyRequest, reply: FastifyReply, min: Role) {
    const { id } = req.params as any
    if (!UUID_RE.test(String(id))) { reply.code(404).send({ error: 'Not found' }); return null }
    const [a] = await db.query(
      `SELECT a.*, d.project_id FROM attachments a
       JOIN markups m ON m.id = a.markup_id JOIN documents d ON d.id = m.document_id WHERE a.id = $1`, [id])
    if (!a) { reply.code(404).send({ error: 'Not found' }); return null }
    if (!(await requireRole(req, reply, a.project_id, min))) return null
    return a
  }

  /** Writes an uploaded photo to disk. Returns the key, or sends an error and returns null. */
  async function savePhoto(file: any, reply: FastifyReply) {
    const ext = PHOTO_TYPES[file.mimetype]
    if (!ext) { file.file.resume(); reply.code(400).send({ error: 'Only JPEG, PNG or WebP photos are supported' }); return null }
    const key = `${randomUUID()}.${ext}`
    await pipeline(file.file, createWriteStream(path.join(filesDir, key)))
    if (file.file.truncated) {
      removeFile(key)
      reply.code(413).send({ error: 'Photo too large (15 MB max)' })
      return null
    }
    return key
  }

  const attRow = async (id: string) => (await db.query(`SELECT ${ATT_COLUMNS} FROM attachments WHERE id = $1`, [id]))[0]

  app.get('/api/markups/:markupId/attachments', { preHandler: auth }, async (req, reply) => {
    const m = await markupWithAccess(req, reply, 'viewer')
    if (!m) return
    return db.query(`SELECT ${ATT_COLUMNS} FROM attachments WHERE markup_id = $1 ORDER BY created_at, id`, [m.id])
  })

  // Text fields (id, caption, width, height) must come before the `photo` file part.
  app.post('/api/markups/:markupId/attachments', { preHandler: auth }, async (req, reply) => {
    const m = await markupWithAccess(req, reply, 'editor')
    if (!m) return
    const file = await req.file({ limits: { fileSize: PHOTO_MAX } })
    if (!file || file.fieldname !== 'photo') return reply.code(400).send({ error: 'No photo' })
    const f = file.fields as any
    const id = String(f.id?.value ?? '')
    if (!UUID_RE.test(id)) { file.file.resume(); return reply.code(400).send({ error: 'A valid id is required' }) }
    const [existing] = await db.query('SELECT markup_id FROM attachments WHERE id = $1', [id])
    if (existing) {
      file.file.resume()
      if (existing.markup_id !== m.id) return reply.code(409).send({ error: 'Attachment belongs to another markup' })
      return attRow(id)
    }
    const key = await savePhoto(file, reply)
    if (!key) return
    try {
      await db.query(
        `INSERT INTO attachments (id, markup_id, file_key, caption, width, height, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, m.id, key, String(f.caption?.value ?? ''), optInt(f.width?.value), optInt(f.height?.value), req.user.id])
    } catch (e) {
      removeFile(key)
      // lost a race with a concurrent retry of the same id
      const [again] = await db.query('SELECT markup_id FROM attachments WHERE id = $1', [id])
      if (again && again.markup_id === m.id) return attRow(id)
      throw e
    }
    return attRow(id)
  })

  app.patch('/api/attachments/:id', { preHandler: auth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'editor')
    if (!a) return
    const caption = (req.body as any)?.caption
    if (typeof caption !== 'string') return reply.code(400).send({ error: 'caption is required' })
    await db.query('UPDATE attachments SET caption = $1 WHERE id = $2', [caption, a.id])
    return attRow(a.id)
  })

  app.put('/api/attachments/:id/annotated', { preHandler: auth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'editor')
    if (!a) return
    const file = await req.file({ limits: { fileSize: PHOTO_MAX } })
    if (!file || file.fieldname !== 'photo') return reply.code(400).send({ error: 'No photo' })
    const key = await savePhoto(file, reply)
    if (!key) return
    await db.query('UPDATE attachments SET annotated_key = $1 WHERE id = $2', [key, a.id])
    removeFile(a.annotated_key)
    return attRow(a.id)
  })

  app.delete('/api/attachments/:id', { preHandler: auth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'editor')
    if (!a) return
    await db.query('DELETE FROM attachments WHERE id = $1', [a.id])
    removeFile(a.file_key)
    removeFile(a.annotated_key)
    return { ok: true }
  })

  app.get('/api/attachments/:id/file', { preHandler: auth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'viewer')
    if (!a) return
    const variant = (req.query as any)?.variant
    const key = variant === 'original' ? a.file_key : variant === 'annotated' ? a.annotated_key : (a.annotated_key ?? a.file_key)
    if (!key) return reply.code(404).send({ error: 'No such variant' })
    const filePath = path.join(filesDir, path.basename(key))
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'File missing' })
    reply.header('Content-Type', EXT_TYPES[path.extname(key).slice(1)] ?? 'application/octet-stream')
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    return reply.send(createReadStream(filePath))
  })

  // ---- Built web app (production) ----
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir })
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'))
  }

  return app
}
