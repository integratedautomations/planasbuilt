import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs'
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

  // ---- Built web app (production) ----
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir })
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'))
  }

  return app
}
