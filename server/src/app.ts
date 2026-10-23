import { existsSync, mkdirSync } from 'node:fs'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import Fastify, { FastifyReply, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import bcrypt from 'bcryptjs'
import websocket from '@fastify/websocket'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { Db } from './db.js'
import { Realtime } from './realtime.js'
import type { Conn } from './realtime.js'
import { Storage, validateS3Config } from './storage.js'
import type { S3Factory } from './storage.js'
import { getSection, storageConfigOf } from './settings.js'
import { defaultsPart, formatTag, missingRequired, nextNumber, publicProjectSettings, readProjectSettings, tagNumber, tagPrefixFromTag } from './projectSettings.js'
import type { ProjectSettings } from './projectSettings.js'
import { registerProjectSettings } from './projectSettingsRoutes.js'
import { registerAdmin } from './admin.js'
import { registerBackups } from './backups.js'
import { installLibrary, previewLibrary } from './standardLibrary.js'
import { BoundedTtlMap } from './ttlmap.js'
import { clientIp, normalizePublicUrl, TRUSTED_PROXIES } from './net.js'
import { countPages, editPdf, isIdentity, pageSizes, PageOpError, parsePageList, remapPages, rotateGeometry } from './pages.js'
import type { PageMapping, PageOp } from './pages.js'
import { accessCan, can, canSeeMarkup, filterMarkups, isRole, normalizeScope, ROLES, stripInternalValues, stripProductCosts } from './roles.js'
import type { Access, Cap, Role, Scope } from './roles.js'

export type { Role }

interface AuthUser { id: string; email: string; isAdmin: boolean; tv?: number }

/** Thrown inside handlers/transactions to answer with a specific status. */
export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly extra?: Record<string, unknown>) { super(message) }
}

const PDF_MAGIC = Buffer.from('%PDF-')
const isPdf = (b: Uint8Array) => b.length >= 5 && Buffer.from(b.subarray(0, 5)).equals(PDF_MAGIC)
/** Cheap content sniffing so a renamed file cannot pass as a photo. */
function photoExt(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 8 && Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (b.length > 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'webp'
  return null
}

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: AuthUser; user: AuthUser }
}

export interface AppOptions {
  db: Db
  jwtSecret: string
  filesDir: string
  webDir?: string
  /** Tests inject a fake S3 client here. */
  s3Factory?: S3Factory
  /** Requests per minute per IP on auth/invite/reset endpoints (and failed logins per email). Tests default to a high value. */
  rateLimitMax?: number
  /** Public origin of the site (e.g. https://pab.example.com). Defaults to the PUBLIC_URL env var. Used for emailed links and CORS. */
  publicUrl?: string
  /** First-run setup code. Defaults to the SETUP_TOKEN env var; when neither is set and there are no users, a random one is logged. */
  setupToken?: string
  /** Invite / resend requests allowed per user per hour (default 30). */
  inviteRateLimitMax?: number
  /** Open websockets allowed per user (default 20). */
  maxSocketsPerUser?: number
}

/** Failed logins per account: after the limit (organization setting, default RL_MAX) the account locks, for the base time (1 min), then 2x, 4x... up to the cap (15 min). */
const FAILURE_MEMORY_MS = 60 * 60_000

export async function buildApp({ db, jwtSecret, filesDir, webDir, s3Factory, rateLimitMax, publicUrl: publicUrlOpt, setupToken: setupTokenOpt, inviteRateLimitMax, maxSocketsPerUser }: AppOptions) {
  const isTest = !!(process.env.NODE_ENV === 'test' || process.env.VITEST)
  const RL_MAX = rateLimitMax ?? (isTest ? 100_000 : 10)
  const INVITE_RL_MAX = inviteRateLimitMax ?? (isTest ? 100_000 : 30)
  const MAX_SOCKETS = maxSocketsPerUser ?? 20
  const publicUrl = normalizePublicUrl(publicUrlOpt ?? process.env.PUBLIC_URL)
  if (!publicUrl && !isTest)
    console.warn('[config] PUBLIC_URL is not set: invite and reset links will use the request Host header and cross-origin API access is disabled. Set PUBLIC_URL (e.g. https://pab.example.com).')
  mkdirSync(filesDir, { recursive: true })
  // Organization settings the hot paths need synchronously (session length, lockout, upload size). Reloaded when an admin saves them.
  const runtime = { sessionDays: 30, lockoutLimit: RL_MAX, lockBaseMs: 60_000, lockCapMs: 15 * 60_000, maxUploadMb: 200, maxUploadBytes: 200 * 1024 * 1024 }
  const reloadRuntime = async () => {
    try {
      const [sec, up] = await Promise.all([getSection(db, 'security'), getSection(db, 'uploads')])
      runtime.sessionDays = sec.session_days
      runtime.lockoutLimit = sec.lockout_limit > 0 ? sec.lockout_limit : RL_MAX
      runtime.lockBaseMs = sec.lockout_base_min * 60_000
      runtime.lockCapMs = Math.max(sec.lockout_cap_min, sec.lockout_base_min) * 60_000
      runtime.maxUploadMb = up.max_upload_mb
      runtime.maxUploadBytes = up.max_upload_mb * 1024 * 1024
    } catch { /* settings table not ready: keep the defaults */ }
  }
  await reloadRuntime()
  const storage = new Storage(filesDir,
    async () => storageConfigOf(await getSection(db, 'storage')),
    s3Factory,
    async () => { const s = (await getSection(db, 'storage')).s3; return validateS3Config(s) ? null : s })
  const app = Fastify({
    logger: false,
    // Forwarding headers (X-Forwarded-For/Proto/Host) are honoured only from private/loopback peers, i.e. the cloudflared
    // container on the docker network; a client reaching us directly cannot spoof them.
    trustProxy: TRUSTED_PROXIES,
    bodyLimit: 10 * 1024 * 1024, // JSON bodies; file uploads stream via multipart (200MB cap below)
  })
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ ...err.extra, error: err.message })
    const code = Number(err?.statusCode)
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `File too large (${runtime.maxUploadMb} MB max)` })
    if (code >= 400 && code < 500) return reply.code(code).send({ error: err.message })
    console.error(`[error] ${req.method} ${req.url.split('?')[0]}:`, err)
    return reply.code(500).send({ error: 'Something went wrong' })
  })
  app.get('/api/health', async (_req, reply) => {
    try {
      await db.query('SELECT 1')
      return { status: 'ok', db: 'ok' }
    } catch {
      return reply.code(503).send({ status: 'error', db: 'error' })
    }
  })
  // Same-origin requests need no CORS headers. Cross-origin browsers get them only for the configured public origin,
  // plus localhost dev servers outside production.
  const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !!origin && (origin === publicUrl || (process.env.NODE_ENV !== 'production' && DEV_ORIGIN.test(origin)))),
  })
  await app.register(jwt, { secret: jwtSecret })
  // Every limiter is keyed on the real client IP (see clientIp), never on a client-controlled header.
  await app.register(rateLimit, { global: false, keyGenerator: clientIp })
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'wasm-unsafe-eval'"], // pdf.js decodes JBIG2/JPEG2000 scans with WebAssembly
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'", 'ws:', 'wss:', 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'frame-src': ["'self'", 'blob:'], // print preview iframe
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
  const rl = { config: { rateLimit: { max: RL_MAX, timeWindow: '1 minute' } } }
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } })
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } }) // ceiling; each route applies the organization's upload limit (runtime.maxUploadBytes)

  // Identity comes from the database on every request (cached up to 60s per process, dropped at once on any change here):
  // is_admin, status and token_version are never trusted from the token.
  interface UserState { at: number; ok: boolean; isAdmin: boolean; tv: number; email: string }
  const userCache = new Map<string, UserState>()
  const forgetUser = (id: string) => { userCache.delete(id) }
  async function userState(id: string): Promise<UserState | null> {
    if (!UUID_RE.test(String(id))) return null
    const hit = userCache.get(id), now = Date.now()
    if (hit && now - hit.at < 60_000) return hit.ok ? hit : null
    const [u] = await db.query('SELECT status, is_admin, token_version, email FROM users WHERE id = $1', [id])
    const st: UserState = { at: now, ok: u?.status === 'active', isAdmin: !!u?.is_admin, tv: u?.token_version ?? 0, email: u?.email ?? '' }
    userCache.set(id, st)
    if (st.ok) await db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [id])
    return st.ok ? st : null
  }

  /** Verifies a JWT string. `want`: 'access' (login token), 'file' (short-lived file-URL token) or 'any'. */
  async function authenticate(raw: string, want: 'access' | 'file' | 'any'): Promise<AuthUser | null> {
    let p: any
    try { p = app.jwt.verify(raw) } catch { return null }
    const isFile = p?.scope === 'file'
    if ((want === 'access' && isFile) || (want === 'file' && !isFile)) return null
    const id = isFile ? p.sub : p?.id
    const st = typeof id === 'string' ? await userState(id) : null
    if (!st || (p.tv ?? 0) !== st.tv) return null
    return { id, email: st.email, isAdmin: st.isAdmin, tv: st.tv }
  }

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization
    return typeof h === 'string' && /^Bearer /i.test(h) ? h.slice(7).trim() : null
  }

  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = bearer(req)
    const u = raw ? await authenticate(raw, 'access') : null
    if (!u) return reply.code(401).send({ error: 'Not signed in' })
    req.user = u
  }

  // GET file routes only: plain URLs (pdf.js, <img>, downloads) cannot send headers, so they may carry a short-lived
  // ?ft= file token (see POST /api/file-token) or, for backward compatibility, the old ?token= login token.
  const fileAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query ?? {}) as any
    const raw = bearer(req)
    let u: AuthUser | null = null
    if (raw) u = await authenticate(raw, 'access')
    else if (typeof q.ft === 'string' && q.ft) u = await authenticate(q.ft, 'file')
    else if (typeof q.token === 'string' && q.token) u = await authenticate(q.token, 'access')
    if (!u) return reply.code(401).send({ error: 'Not signed in' })
    req.user = u
  }

  // Malformed ids in the URL are a plain 404 before any handler or SQL sees them.
  app.addHook('preValidation', async (req, reply) => {
    const p = req.params as Record<string, string> | undefined
    if (!p) return
    for (const k of ['id', 'rid', 'markupId', 'userId'])
      if (k in p && !UUID_RE.test(String(p[k]))) return reply.code(404).send({ error: 'Not found' })
  })

  const realtime = new Realtime()
  app.addHook('onClose', async () => realtime.close())
  const cid = (req: FastifyRequest) => {
    const h = req.headers['x-client-id']
    return typeof h === 'string' ? h : null
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  const sign = (u: { id: string; email: string; is_admin: boolean; token_version?: number }) =>
    app.jwt.sign({ id: u.id, email: u.email, isAdmin: u.is_admin, tv: u.token_version ?? 0 }, { expiresIn: `${runtime.sessionDays}d` })
  const publicUser = ({ token_version: _tv, password_hash: _ph, ...u }: any) => u

  // Short-lived token for plain file URLs: use as ?ft= on GET file routes instead of putting the login token in a URL.
  app.post('/api/file-token', { preHandler: auth }, async (req) => ({
    ft: app.jwt.sign({ sub: req.user.id, scope: 'file', tv: req.user.tv ?? 0 } as any, { expiresIn: '10m' }), expires_in: 600,
  }))

  const userCount = async () =>
    (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM users'))[0].count

  /** Someone's role, scope and the project's cost setting; null when they are not a member. */
  async function projectAccess(userId: string, projectId: string): Promise<Access | null> {
    const rows = await db.query<{ role: Role; scope: unknown; editors_see_costs: boolean; locked: boolean }>(
      `SELECT m.role, m.scope, p.editors_see_costs, (p.settings->>'locked') = 'true' AS locked FROM project_members m JOIN projects p ON p.id = m.project_id
       WHERE m.project_id = $1 AND m.user_id = $2`, [projectId, userId])
    const r = rows[0]
    return r ? { role: r.role, scope: normalizeScope(r.scope), editorsSeeCosts: r.editors_see_costs !== false, locked: !!r.locked } : null
  }

  /** What requireCap resolved for a request, for handlers that need the role or scope afterwards. */
  const accessByReq = new WeakMap<FastifyRequest, Access>()
  const accessOf = (req: FastifyRequest) => accessByReq.get(req)!

  /** Answers 403 unless the user is a member of the project whose role has the capability. Returns their access. */
  async function requireCap(req: FastifyRequest, reply: FastifyReply, projectId: string, cap: Cap) {
    const access = await projectAccess(req.user.id, projectId)
    if (!accessCan(access, cap)) {
      reply.code(403).send({ error: access?.locked && can(access.role, cap, { editorsSeeCosts: access.editorsSeeCosts }) ? 'This project is locked. Only admins can make changes.' : 'Not allowed' })
      return null
    }
    accessByReq.set(req, access!)
    return access!
  }

  /** What a user may see across the whole organization (catalog and symbol sets are shared by all projects). */
  async function orgVisibility(user: { id: string; isAdmin: boolean }) {
    if (user.isAdmin) return { costs: true, internal: true }
    const rows = await db.query<{ role: Role; editors_see_costs: boolean }>(
      'SELECT m.role, p.editors_see_costs FROM project_members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = $1', [user.id])
    return {
      costs: rows.some(r => can(r.role, 'costs.view', { editorsSeeCosts: r.editors_see_costs })),
      internal: rows.some(r => can(r.role, 'internal.view')),
    }
  }

  /** Keys of fields flagged `internal` in any symbol set or device type (clients never see their values). */
  async function internalFieldKeys(): Promise<Set<string>> {
    const rows = await db.query<{ key: string }>(
      `SELECT DISTINCT f->>'key' AS key FROM (
         SELECT jsonb_array_elements(fields) AS f FROM symbol_sets
         UNION ALL SELECT jsonb_array_elements(fields) FROM device_types) x
       WHERE f->>'internal' = 'true'`)
    return new Set(rows.map(r => r.key).filter(Boolean))
  }
  const withoutInternalDefs = (defs: any) => (Array.isArray(defs) ? defs.filter((d: any) => !d?.internal) : defs)

  /** A markup list as this user may see it: sub scope applied, internal field values removed for clients. */
  async function visibleMarkups<T extends { symbol_set_id?: string | null; layer_id?: string | null; fields?: Record<string, any> }>(access: Access, list: T[]) {
    const out = filterMarkups(access, list)
    if (can(access.role, 'internal.view')) return out
    const keys = await internalFieldKeys()
    return out.map(m => stripInternalValues(m, keys))
  }

  function validNewUser(body: any) {
    const { email, name, password } = body ?? {}
    return email && name && typeof password === 'string' && password.length >= 8
  }

  // ---- Realtime ----
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const q = (req.query ?? {}) as any
    let closed = false
    let conn: Conn | null = null
    // Handlers are attached synchronously (a message sent in the client's onopen must not be lost, and a socket that
    // closes while we authenticate must still be cleaned up); everything else waits for this promise.
    const ready = (async () => {
      // Browsers cannot set headers on a WebSocket, so the token (login or file token) rides in the query string.
      const user = await authenticate(String(q.token ?? q.ft ?? ''), 'any').catch(() => null)
      if (!user) { socket.close(4401, 'Invalid token'); return null }
      const [u] = await db.query("SELECT name, avatar_key, avatar_version FROM users WHERE id = $1 AND status = 'active'", [user.id])
      if (!u) { socket.close(4401, 'Invalid token'); return null }
      if (closed) return null
      if (realtime.countFor(user.id) >= MAX_SOCKETS) { socket.close(4429, 'Too many connections'); return null }
      conn = realtime.add(socket, {
        clientId: typeof q.clientId === 'string' && q.clientId ? q.clientId : randomUUID(),
        userId: user.id, name: u.name, avatar: u.avatar_key ? u.avatar_version : null,
      })
      return { user, conn }
    })().catch(() => { try { socket.close(4401, 'Invalid token') } catch { /* going away */ } return null })
    // Messages are handled one at a time, in arrival order (a presence update must not overtake the join before it).
    let queue: Promise<unknown> = ready
    socket.on('message', (data) => {
      queue = queue.then(async () => {
        const ctx = await ready
        if (!ctx || closed) return
        const { user, conn } = ctx
        let m: any
        try { m = JSON.parse(String(data)) } catch { return realtime.error(conn, 'Bad message') }
        if (!m || typeof m !== 'object') return realtime.error(conn, 'Bad message')
        if (m.type === 'ping') realtime.pong(conn)
        else if (m.type === 'presence') realtime.presence(conn, m)
        else if (m.type === 'join') {
          if (!realtime.allowJoin(conn)) return realtime.error(conn, 'Too many join requests')
          try {
            const id = String(m.documentId ?? '')
            const [doc] = UUID_RE.test(id) ? await db.query('SELECT project_id FROM documents WHERE id = $1', [id]) : []
            const access = doc ? await projectAccess(user.id, doc.project_id) : null
            if (!doc || !access) return realtime.error(conn, 'Not allowed')
            if (closed) return
            realtime.join(conn, id, access)
          } catch { realtime.error(conn, 'Join failed') }
        }
      }).catch(() => {})
    })
    socket.on('close', () => { closed = true; if (conn) realtime.remove(conn) })
    socket.on('error', () => socket.terminate())
  })

  // ---- Auth ----
  app.get('/api/auth/status', async () => ({ needsSetup: (await userCount()) === 0 }))

  // First-run setup code: whoever reaches a fresh install first must still know it. SETUP_TOKEN (env) wins; otherwise a
  // random code is generated while there are no users and printed to the server log.
  let setupCode: string | null = setupTokenOpt || process.env.SETUP_TOKEN || null
  const sha = (s: string) => createHash('sha256').update(s).digest()
  const setupCodeMatches = (given: unknown) => typeof given === 'string' && !!setupCode && timingSafeEqual(sha(given.trim()), sha(setupCode))
  if (!setupCode && (await userCount()) === 0) {
    setupCode = randomBytes(12).toString('base64url')
    console.log(`First-run setup code: ${setupCode}`)
  }

  // First user only: creates the initial admin. Later users are added by an admin.
  app.post('/api/auth/setup', rl, async (req, reply) => {
    if ((await userCount()) > 0) return reply.code(409).send({ error: 'Already set up' })
    if (!setupCode) { // every user was removed after startup: issue a fresh code
      setupCode = randomBytes(12).toString('base64url')
      console.log(`First-run setup code: ${setupCode}`)
    }
    if (!setupCodeMatches((req.body as any)?.setupCode))
      return reply.code(403).send({ error: 'Wrong setup code. It is printed in the server log (docker compose logs app) or set as SETUP_TOKEN.' })
    if (!validNewUser(req.body))
      return reply.code(400).send({ error: 'Email, name and an 8+ character password are required' })
    const { email, name, password } = req.body as any
    const hash = await bcrypt.hash(password, 10)
    // One transaction under an advisory lock: two simultaneous setups cannot both create an admin.
    const user = await db.transaction(async q => {
      await q('SELECT pg_advisory_xact_lock(727001)')
      const [u] = await q(
        `INSERT INTO users (email, name, password_hash, is_admin)
         SELECT $1::text, $2::text, $3::text, true WHERE NOT EXISTS (SELECT 1 FROM users)
         RETURNING id, email, name, is_admin, token_version`, [String(email).toLowerCase(), String(name), hash])
      return u
    })
    if (!user) return reply.code(409).send({ error: 'Already set up' })
    setupCode = null
    return { token: sign(user), user: publicUser(user) }
  })

  // Failed-login bookkeeping per email (the route-level limiter above covers per-IP). Accounts that exist and emails
  // that do not live in separate bounded maps with identical behaviour, so spraying junk emails can only churn the
  // second one and never evicts a real account's lockout. After RL_MAX failures the account locks, for 1 min, then
  // 2, 4... up to 15 min; attempts made while locked do not extend it. Entries are forgotten an hour after the last failure.
  interface Fail { n: number; lockedUntil: number }
  const accountFailures = new BoundedTtlMap<Fail>(10_000, FAILURE_MEMORY_MS)
  const unknownFailures = new BoundedTtlMap<Fail>(10_000, FAILURE_MEMORY_MS)
  const DUMMY_HASH = bcrypt.hashSync('planmark-no-such-user', 10)

  app.post('/api/auth/login', rl, async (req, reply) => {
    const { email, password } = (req.body ?? {}) as any
    const key = String(email ?? '').toLowerCase().slice(0, 320)
    const [user] = await db.query('SELECT * FROM users WHERE email = $1', [key])
    const real = !!user && user.status !== 'invited'
    const failures = real ? accountFailures : unknownFailures
    const now = Date.now()
    const f = failures.get(key)
    if (f && f.lockedUntil > now) {
      const wait = Math.ceil((f.lockedUntil - now) / 1000)
      reply.header('Retry-After', String(wait))
      return reply.code(429).send({ error: `Too many attempts. Try again in ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : 'a minute'}.` })
    }
    // Always spend one bcrypt compare so response time does not reveal whether the email exists.
    const ok = await bcrypt.compare(String(password ?? ''), real ? user.password_hash : DUMMY_HASH)
    if (!real || !ok) {
      const n = (f?.n ?? 0) + 1
      failures.set(key, { n, lockedUntil: n >= runtime.lockoutLimit ? now + Math.min(runtime.lockCapMs, runtime.lockBaseMs * 2 ** Math.min(n - runtime.lockoutLimit, 10)) : 0 })
      return reply.code(401).send({ error: 'Wrong email or password' })
    }
    accountFailures.delete(key)
    if (user.status === 'deactivated')
      return reply.code(403).send({ error: 'This account has been deactivated. Ask an admin.' })
    return { token: sign(user), user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin, can_create_projects: user.is_admin || !!user.can_create_projects, avatar: user.avatar_key ? user.avatar_version : null } }
  })

  app.get('/api/me', { preHandler: auth }, async (req) => {
    const [user] = await db.query(
      `SELECT id, email, name, is_admin, (is_admin OR can_create_projects) AS can_create_projects,
         CASE WHEN avatar_key IS NULL THEN NULL ELSE avatar_version END AS avatar FROM users WHERE id = $1`, [req.user.id])
    return user
  })

  // ---- Per-user preferences (hotkeys, layout, favorites...): any signed-in user, their own row only ----
  app.get('/api/me/prefs', { preHandler: auth }, async (req) => {
    const [row] = await db.query('SELECT prefs, updated_at FROM user_prefs WHERE user_id = $1', [req.user.id])
    return row ? { prefs: row.prefs, updated_at: row.updated_at } : { prefs: {}, updated_at: null }
  })

  app.put('/api/me/prefs', { preHandler: auth }, async (req, reply) => {
    const prefs = (req.body as any)?.prefs
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))
      return reply.code(400).send({ error: 'prefs must be an object' })
    const json = JSON.stringify(prefs)
    if (json.length > 256 * 1024) return reply.code(413).send({ error: 'Preferences are too large' })
    const [row] = await db.query(
      `INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()
       RETURNING prefs, updated_at`, [req.user.id, json])
    return row
  })

  // ---- Users (app admins) ----
  app.post('/api/users', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    if (!validNewUser(req.body))
      return reply.code(400).send({ error: 'Email, name and an 8+ character password are required' })
    const { email, name, password, isAdmin, canCreateProjects } = req.body as any
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [String(email).toLowerCase()])
    if (exists.length) return reply.code(409).send({ error: 'Email already in use' })
    const [user] = await db.query(
      'INSERT INTO users (email, name, password_hash, is_admin, can_create_projects) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, is_admin, can_create_projects',
      [String(email).toLowerCase(), name, await bcrypt.hash(password, 10), !!isAdmin, !!canCreateProjects])
    return user
  })

  // ---- Projects ----
  app.get('/api/projects', { preHandler: auth }, async (req) =>
    db.query(
      `SELECT p.id, p.name, p.created_at, p.status, p.completed_at, m.role,
         (SELECT count(*)::int FROM documents d WHERE d.project_id = p.id) AS document_count
       FROM projects p JOIN project_members m ON m.project_id = p.id
       WHERE m.user_id = $1 ORDER BY p.created_at DESC`, [req.user.id]))

  // Creating a project makes you its admin (members, invites, uploads), so it is limited to app admins and to users an
  // admin has granted can_create_projects.
  app.post('/api/projects', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) {
      const [u] = await db.query('SELECT can_create_projects FROM users WHERE id = $1', [req.user.id])
      if (!u?.can_create_projects) return reply.code(403).send({ error: 'Ask an admin to create projects for you' })
    }
    const name = String((req.body as any)?.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'Project name is required' })
    // New projects start from the organization's defaults (a copy: later changes to the defaults do not touch existing projects).
    const defaults = defaultsPart(readProjectSettings(await getSection(db, 'project_defaults')))
    const [project] = await db.query(
      'INSERT INTO projects (name, created_by, settings) VALUES ($1,$2,$3) RETURNING *', [name, req.user.id, JSON.stringify(defaults)])
    await db.query('INSERT INTO project_members VALUES ($1,$2,$3)', [project.id, req.user.id, 'admin'])
    return { ...shapeProject(project), role: 'admin' }
  })

  /** A project row as the API shows it: settings completed with defaults, the logo's file key hidden. */
  const shapeProject = ({ settings, ...p }: any) => ({ ...p, settings: publicProjectSettings(readProjectSettings(settings)) })

  app.get('/api/projects/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    const access = await requireCap(req, reply, id, 'view')
    if (!access) return
    const [project] = await db.query('SELECT * FROM projects WHERE id = $1', [id])
    return { ...shapeProject(project), role: access.role, scope: access.scope, can_see_costs: accessCan(access, 'costs.view') }
  })

  // Mark a project Complete or reopen it (anyone who can edit plans), and/or switch the "editors see costs" setting (project admins).
  // Completed projects stay fully usable.
  app.patch('/api/projects/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    const b = (req.body ?? {}) as any
    const hasStatus = b.status !== undefined, hasCosts = b.editors_see_costs !== undefined
    const hasCable = b.cable_slack_pct !== undefined || b.cable_drop_ft !== undefined
    if (!hasStatus && !hasCosts && !hasCable) return reply.code(400).send({ error: "status must be 'open' or 'completed'" })
    const access = await requireCap(req, reply, id, hasCosts ? 'members.manage' : 'plans.edit')
    if (!access) return
    if (hasStatus && b.status !== 'open' && b.status !== 'completed') return reply.code(400).send({ error: "status must be 'open' or 'completed'" })
    if (hasCosts && typeof b.editors_see_costs !== 'boolean') return reply.code(400).send({ error: 'editors_see_costs must be true or false' })
    if (hasStatus && !accessCan(access, 'plans.edit')) return reply.code(403).send({ error: 'Not allowed' })
    const numIn = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null)
    if (b.cable_slack_pct !== undefined && numIn(b.cable_slack_pct, 1000) === null) return reply.code(400).send({ error: 'Slack must be 0 to 1000 percent' })
    if (b.cable_drop_ft !== undefined && numIn(b.cable_drop_ft, 10000) === null) return reply.code(400).send({ error: 'Drop length must be 0 to 10000 feet' })
    if (hasCable && !accessCan(access, 'plans.edit')) return reply.code(403).send({ error: 'Not allowed' })
    let project: any
    if (hasStatus)
      [project] = await db.query(
        `UPDATE projects SET status = $1, completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE NULL END WHERE id = $2 RETURNING *`, [b.status, id])
    if (hasCosts)
      [project] = await db.query('UPDATE projects SET editors_see_costs = $1 WHERE id = $2 RETURNING *', [b.editors_see_costs, id])
    if (hasCable)
      [project] = await db.query(
        'UPDATE projects SET cable_slack_pct = coalesce($1, cable_slack_pct), cable_drop_ft = coalesce($2, cable_drop_ft) WHERE id = $3 RETURNING *',
        [b.cable_slack_pct ?? null, b.cable_drop_ft ?? null, id])
    return { ...shapeProject(project), role: access.role, scope: access.scope }
  })

  app.get('/api/projects/:id/members', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    const access = await requireCap(req, reply, id, 'view')
    if (!access) return
    const rows = await db.query(
      `SELECT u.id, u.email, u.name, u.status, m.role, m.scope FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 ORDER BY u.name`, [id])
    // Scopes are only for the people who manage members.
    return accessCan(access, 'members.manage') ? rows : rows.map(({ scope: _s, ...r }: any) => r)
  })

  app.put('/api/projects/:id/members', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'members.manage'))) return
    const { email, role } = (req.body ?? {}) as any
    if (!isRole(role)) return reply.code(400).send({ error: 'Bad role' })
    const [user] = await db.query("SELECT id FROM users WHERE email = $1 AND status <> 'deactivated'", [String(email ?? '').toLowerCase()])
    if (!user) return reply.code(404).send({ error: 'No active user with that email' })
    if (role !== 'admin' && !(await keepsAnAdmin(id, user.id))) return reply.code(400).send({ error: 'A project needs at least one admin' })
    // The scope only matters for a sub. Not sent = keep the stored one; a non-sub role resets it to empty.
    const scope = role !== 'sub' ? normalizeScope(null) : (req.body as any).scope !== undefined ? normalizeScope((req.body as any).scope) : null
    await db.query(
      `INSERT INTO project_members (project_id, user_id, role, scope) VALUES ($1,$2,$3, coalesce($4::jsonb, '{"sets":[],"layers":[]}'::jsonb))
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role,
         scope = CASE WHEN $4::jsonb IS NULL THEN project_members.scope ELSE EXCLUDED.scope END`,
      [id, user.id, role, scope ? JSON.stringify(scope) : null])
    await refreshAccess(user.id, id)
    return { ok: true }
  })

  /** True when the project would still have an admin if `userId` stopped being one. */
  async function keepsAnAdmin(projectId: string, userId: string) {
    return (await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'admin' AND user_id <> $2", [projectId, userId]))[0].n > 0
  }

  /** Pushes a changed role or scope to the person's open sockets so a sub's filtering follows the change at once. */
  async function refreshAccess(userId: string, projectId: string) {
    const access = await projectAccess(userId, projectId)
    if (!access) return
    const docs = await db.query<{ id: string }>('SELECT id FROM documents WHERE project_id = $1', [projectId])
    realtime.setAccess(userId, docs.map(d => d.id), access)
    realtime.markupsResetFor(userId, docs.map(d => d.id))
  }

  /** Removes a person's live sockets from a project's document rooms (membership was taken away). */
  async function dropFromProject(userId: string, projectId: string) {
    const docs = await db.query<{ id: string }>('SELECT id FROM documents WHERE project_id = $1', [projectId])
    realtime.dropUserFromDocs(userId, docs.map(d => d.id))
  }

  // ---- Documents ----
  const safeName = (n: string) => n.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 120) || 'file'
  /** Content headers for served files: never sniffed, shown inline with a filename. */
  function fileHeaders(reply: FastifyReply, type: string, filename: string) {
    reply.header('Content-Type', type)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Disposition', `inline; filename="${safeName(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  }
  const lockDocument = async (q: Q, docId: string) => {
    const [d] = await q('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [docId])
    if (!d) throw new HttpError(404, 'Not found')
  }

  /** Reads an uploaded PDF fully, checks it is one, and counts its pages on the server (the client's count is not trusted). */
  async function readPdfUpload(file: any, reply: FastifyReply) {
    if (file.mimetype !== 'application/pdf' && !file.filename.toLowerCase().endsWith('.pdf')) {
      file.file.resume(); reply.code(400).send({ error: 'Only PDF files are supported' }); return null
    }
    const bytes = new Uint8Array(await file.toBuffer())
    if (file.file.truncated) { reply.code(413).send({ error: `File too large (${runtime.maxUploadMb} MB max)` }); return null }
    if (!isPdf(bytes)) { reply.code(400).send({ error: 'That is not a PDF file' }); return null }
    let pageCount: number
    try { pageCount = await countPages(bytes) } catch { reply.code(400).send({ error: 'That is not a readable PDF' }); return null }
    if (pageCount < 1) { reply.code(400).send({ error: 'That PDF has no pages' }); return null }
    return { bytes, pageCount }
  }
  app.get('/api/projects/:id/documents', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'view'))) return
    return db.query(
      `SELECT d.id, d.name, d.created_at, d.device_scale, r.id AS revision_id, r.revision, r.page_count
       FROM documents d
       JOIN LATERAL (SELECT * FROM document_revisions WHERE document_id = d.id ORDER BY revision DESC LIMIT 1) r ON true
       WHERE d.project_id = $1 ORDER BY d.name`, [id])
  })

  app.post('/api/projects/:id/documents', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'plans.edit'))) return
    const file = await req.file({ limits: { fileSize: runtime.maxUploadBytes } })
    if (!file) return reply.code(400).send({ error: 'No file' })
    const up = await readPdfUpload(file, reply)
    if (!up) return
    const pageCount = up.pageCount
    const fields = file.fields as any
    const name = String(fields.name?.value || file.filename.replace(/\.pdf$/i, ''))
    const fileKey = await storage.save('pdf', up.bytes)
    try {
      const { doc, rev } = await db.transaction(async q => {
        const [doc] = await q('INSERT INTO documents (project_id, name) VALUES ($1,$2) RETURNING *', [id, name])
        const [rev] = await q(
          `INSERT INTO document_revisions (document_id, revision, file_key, page_count, uploaded_by)
           VALUES ($1, 1, $2, $3, $4) RETURNING *`, [doc.id, fileKey, pageCount, req.user.id])
        return { doc, rev }
      })
      return { id: doc.id, name: doc.name, created_at: doc.created_at, revision_id: rev.id, revision: 1, page_count: pageCount }
    } catch (e) { void storage.remove(fileKey); throw e }
  })

  async function documentWithAccess(req: FastifyRequest, reply: FastifyReply, cap: Cap) {
    const { id } = req.params as any
    const [doc] = await db.query('SELECT * FROM documents WHERE id = $1', [id])
    if (!doc) { reply.code(404).send({ error: 'Not found' }); return null }
    if (!(await requireCap(req, reply, doc.project_id, cap))) return null
    return doc
  }

  app.get('/api/documents/:id', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'view')
    if (!doc) return
    const revisions = await db.query(
      'SELECT id, revision, page_count, created_at, kind, label FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC', [doc.id])
    return { ...doc, revisions }
  })

  app.patch('/api/documents/:id', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const b = (req.body ?? {}) as any
    const hasScale = b.device_scale !== undefined
    const hasName = b.name !== undefined || !hasScale
    const name = String(b.name ?? '').trim()
    if (hasName && !name) return reply.code(400).send({ error: 'Name is required' })
    const ds = Number(b.device_scale)
    if (hasScale && !(Number.isFinite(ds) && ds >= 0.25 && ds <= 4)) return reply.code(400).send({ error: 'device_scale must be between 0.25 and 4' })
    const [updated] = await db.query(
      'UPDATE documents SET name = $1, device_scale = $2 WHERE id = $3 RETURNING *',
      [hasName ? name : doc.name, hasScale ? Math.round(ds * 100) / 100 : doc.device_scale, doc.id])
    if (hasScale) realtime.deviceScaleChanged(doc.id, updated.device_scale, req.user.id, cid(req))
    return updated
  })

  app.delete('/api/documents/:id', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.delete')
    if (!doc) return
    const keys = await db.query<{ k: string }>(
      `SELECT file_key AS k FROM document_revisions WHERE document_id = $1
       UNION SELECT a.file_key FROM attachments a JOIN markups m ON m.id = a.markup_id WHERE m.document_id = $1
       UNION SELECT a.annotated_key FROM attachments a JOIN markups m ON m.id = a.markup_id WHERE m.document_id = $1 AND a.annotated_key IS NOT NULL`, [doc.id])
    await db.query('DELETE FROM documents WHERE id = $1', [doc.id])
    await releaseFiles(keys.map(r => r.k))
    return { ok: true }
  })

  app.get('/api/documents/:id/file', { preHandler: fileAuth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'view')
    if (!doc) return
    const rid = (req.query as any)?.revision
    const [rev] = rid
      ? (UUID_RE.test(String(rid)) ? await db.query(
        'SELECT id, file_key FROM document_revisions WHERE document_id = $1 AND id = $2', [doc.id, rid]) : [])
      : await db.query('SELECT id, file_key FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
    if (!rev) return reply.code(404).send({ error: 'Revision not found' })
    const stream = await storage.open(rev.file_key)
    if (!stream) return reply.code(404).send({ error: 'File missing' })
    fileHeaders(reply, 'application/pdf', `${doc.name}.pdf`)
    // Current-revision URL changes meaning on upload, so only explicit revisions are immutable.
    reply.header('Cache-Control', rid ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    return reply.send(stream)
  })

  const REVISION_SQL = `SELECT r.id, r.revision, r.page_count, r.created_at, r.uploaded_by, u.name AS uploaded_by_name,
      r.kind, r.label, r.note, (r.markups_snapshot IS NOT NULL) AS has_snapshot
    FROM document_revisions r LEFT JOIN users u ON u.id = r.uploaded_by WHERE r.document_id = $1 ORDER BY r.revision DESC`

  app.get('/api/documents/:id/revisions', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'view')
    if (!doc) return
    return db.query(REVISION_SQL, [doc.id])
  })

  type Q = Db['query']

  /** Everything a revision freezes besides the PDF: all live markups (full rows), photo references and page scales. */
  async function liveSnapshot(q: Q, docId: string) {
    const cols = MARKUP_COLUMNS.split(', ').map(c => `m.${c}`).join(', ')
    const markups = await q(
      `SELECT ${cols}, cu.name AS created_by_name, uu.name AS updated_by_name
       FROM markups m LEFT JOIN users cu ON cu.id = m.created_by LEFT JOIN users uu ON uu.id = m.updated_by
       WHERE m.document_id = $1 AND NOT m.deleted ORDER BY m.created_at`, [docId])
    const attachments = await q(
      `SELECT a.id, a.markup_id, a.file_key, a.annotated_key, a.caption, a.width, a.height, a.created_at
       FROM attachments a JOIN markups m ON m.id = a.markup_id WHERE m.document_id = $1 AND NOT m.deleted ORDER BY a.created_at, a.id`, [docId])
    const scales = await q('SELECT page, points_per_foot, label FROM page_scales WHERE document_id = $1 ORDER BY page', [docId])
    return { markups, attachments, scales }
  }
  type Snapshot = Awaited<ReturnType<typeof liveSnapshot>>

  /** The newest revision is "live" (its markups are the document's). Before something supersedes it, freeze them into it. */
  async function freezeLatest(q: Q, docId: string): Promise<Snapshot | null> {
    const [latest] = await q('SELECT id, (markups_snapshot IS NULL) AS live FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [docId])
    if (!latest?.live) return null
    const s = await liveSnapshot(q, docId)
    await q('UPDATE document_revisions SET markups_snapshot = $2, attachments_snapshot = $3, scales_snapshot = $4 WHERE id = $1',
      [latest.id, JSON.stringify(s.markups), JSON.stringify(s.attachments), JSON.stringify(s.scales)])
    return s
  }

  interface NewRevision { kind: 'upload' | 'issued' | 'restore'; label: string; note: string; fileKey: string; pageCount: number; userId: string; snapshot?: Snapshot | null }
  async function insertRevision(q: Q, docId: string, r: NewRevision) {
    const [rev] = await q(
      `INSERT INTO document_revisions (document_id, revision, file_key, page_count, uploaded_by, kind, label, note, markups_snapshot, attachments_snapshot, scales_snapshot)
       VALUES ($1, (SELECT coalesce(max(revision), 0) + 1 FROM document_revisions WHERE document_id = $1), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, revision, page_count, created_at, uploaded_by, kind, label, note`,
      [docId, r.fileKey, r.pageCount, r.userId, r.kind, r.label, r.note,
        r.snapshot ? JSON.stringify(r.snapshot.markups) : null, r.snapshot ? JSON.stringify(r.snapshot.attachments) : null,
        r.snapshot ? JSON.stringify(r.snapshot.scales) : null])
    return rev
  }

  // New revision: becomes current, old ones are kept. Markups stay keyed to document+page, so they carry forward;
  // those on pages beyond the new page count are kept and reported as orphaned. The markups as they were at this moment
  // are frozen into the revision being replaced (so it can be viewed and compared later).
  app.post('/api/documents/:id/revisions', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const file = await req.file({ limits: { fileSize: runtime.maxUploadBytes } })
    if (!file) return reply.code(400).send({ error: 'No file' })
    const up = await readPdfUpload(file, reply)
    if (!up) return
    const pageCount = up.pageCount
    const fileKey = await storage.save('pdf', up.bytes)
    const label = String((file.fields as any).label?.value ?? '').slice(0, 200)
    const note = String((file.fields as any).note?.value ?? '').slice(0, 2000)
    let rev: any
    try {
      rev = await db.transaction(async q => {
        await lockDocument(q, doc.id)
        await freezeLatest(q, doc.id)
        return insertRevision(q, doc.id, { kind: 'upload', label, note, fileKey, pageCount, userId: req.user.id })
      })
    } catch (e) { void storage.remove(fileKey); throw e }
    const orphans = await db.query<{ id: string; page: number }>(
      'SELECT id, page FROM markups WHERE document_id = $1 AND NOT deleted AND page > $2 ORDER BY page', [doc.id, pageCount])
    realtime.revisionChanged(doc.id, rev.id, rev.revision, req.user.id, cid(req))
    return { ...rev, orphaned_markups: orphans.length, orphaned_pages: [...new Set(orphans.map(o => o.page))] }
  })

  // Issue revision: freeze the current PDF + markups + device data under a name, without changing anything live.
  app.post('/api/documents/:id/revisions/issue', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const b = (req.body ?? {}) as any
    const label = String(b.label ?? '').trim().slice(0, 200)
    if (!label) return reply.code(400).send({ error: 'A revision name is required' })
    const note = String(b.note ?? '').trim().slice(0, 2000)
    const rev = await db.transaction(async q => {
      await lockDocument(q, doc.id)
      const [latest] = await q('SELECT file_key, page_count FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
      const snapshot = await liveSnapshot(q, doc.id)
      await freezeLatest(q, doc.id) // the revision being issued from is frozen at the same instant
      return insertRevision(q, doc.id, { kind: 'issued', label, note, fileKey: latest.file_key, pageCount: latest.page_count, userId: req.user.id, snapshot })
    })
    realtime.revisionChanged(doc.id, rev.id, rev.revision, req.user.id, cid(req))
    return rev
  })

  // Make an older revision current without deleting newer ones: the present state is frozen first, then a new revision
  // points at the older PDF and the live markups / scales are replaced by that revision's snapshot.
  app.post('/api/documents/:id/revisions/:rid/make-current', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const { rid } = req.params as any
    const [src] = UUID_RE.test(String(rid)) ? await db.query(
      `SELECT id, revision, file_key, page_count, markups_snapshot, scales_snapshot
       FROM document_revisions WHERE document_id = $1 AND id = $2`, [doc.id, rid]) : []
    if (!src) return reply.code(404).send({ error: 'Revision not found' })
    const [latest] = await db.query('SELECT id, file_key, page_count FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
    if (latest.id === src.id) return reply.code(400).send({ error: 'That revision is already the current one' })
    if (!src.markups_snapshot) return reply.code(400).send({ error: 'That revision has no saved markups to restore' })
    const snapMarkups = src.markups_snapshot as any[]
    const snapScales = (src.scales_snapshot ?? []) as any[]
    const userId = req.user.id
    const result = await db.transaction(async q => {
      await lockDocument(q, doc.id)
      // The decision above was made on a read outside the lock: confirm nothing superseded it meanwhile.
      const [now] = await q('SELECT id FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
      if (now.id !== latest.id) throw new HttpError(409, 'Plan changed, try again')
      const before = await liveSnapshot(q, doc.id)
      await freezeLatest(q, doc.id)
      await insertRevision(q, doc.id, {
        kind: 'restore', label: `Before restoring Rev ${src.revision}`, note: '', fileKey: latest.file_key, pageCount: latest.page_count, userId, snapshot: before })
      const created = await insertRevision(q, doc.id, {
        kind: 'restore', label: '', note: '', fileKey: src.file_key, pageCount: src.page_count, userId })
      const label = `Rev ${created.revision} (restored from Rev ${src.revision})`
      await q('UPDATE document_revisions SET label = $2 WHERE id = $1', [created.id, label])

      // References that may have been deleted since the snapshot was taken fall back to null
      const known = async (table: string, ids: string[]) => new Set(ids.length
        ? (await q<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).map(r => r.id) : [])
      const uniq = (k: string) => [...new Set(snapMarkups.map(m => m[k]).filter(Boolean))] as string[]
      const layers = await known('layers', uniq('layer_id'))
      const sets = await known('symbol_sets', uniq('symbol_set_id'))
      const types = await known('device_types', uniq('device_type_id'))
      const products = await known('products', uniq('product_id'))
      const keep = new Set(snapMarkups.map(m => m.id))
      const liveRows = await q<{ id: string }>('SELECT id FROM markups WHERE document_id = $1 AND NOT deleted', [doc.id])
      const removed = liveRows.filter(r => !keep.has(r.id)).map(r => r.id)
      if (removed.length) {
        await q('UPDATE markups SET deleted = true, version = version + 1, struct_version = version + 1, updated_by = $2, updated_at = now() WHERE id = ANY($1::uuid[])', [removed, userId])
        await q(`INSERT INTO markup_events (markup_id, user_id, action, changes)
                 SELECT unnest($1::uuid[]), $2, 'deleted', $3::jsonb`, [removed, userId, JSON.stringify({ reason: `restored Rev ${src.revision}` })])
      }
      // One statement for all snapshot markups (a repeated id in the snapshot: the last one wins).
      const rows = new Map<string, unknown>()
      for (const m of snapMarkups)
        rows.set(m.id, {
          id: m.id, page: m.page, type: m.type, geometry: m.geometry, style: m.style ?? {}, text: m.text ?? '',
          layer_id: layers.has(m.layer_id) ? m.layer_id : null, symbol_set_id: sets.has(m.symbol_set_id) ? m.symbol_set_id : null,
          tag: m.tag ?? '', status: m.status ?? '', fields: m.fields ?? {}, created_by: m.created_by ?? userId,
          device_type_id: types.has(m.device_type_id) ? m.device_type_id : null, product_id: products.has(m.product_id) ? m.product_id : null,
        })
      if (rows.size)
        await q(
          `INSERT INTO markups (id, document_id, page, type, geometry, style, text, layer_id, symbol_set_id, tag, status, fields, created_by, updated_by, device_type_id, product_id)
           SELECT s.id, $1::uuid, s.page, s.type, s.geometry, s.style, s.text, s.layer_id, s.symbol_set_id, s.tag, s.status, s.fields, s.created_by, $3::uuid, s.device_type_id, s.product_id
           FROM jsonb_to_recordset($2::jsonb) AS s(id uuid, page int, type text, geometry jsonb, style jsonb, text text, layer_id uuid,
             symbol_set_id uuid, tag text, status text, fields jsonb, created_by uuid, device_type_id uuid, product_id uuid)
           ON CONFLICT (id) DO UPDATE SET page = EXCLUDED.page, type = EXCLUDED.type, geometry = EXCLUDED.geometry,
             style = EXCLUDED.style, text = EXCLUDED.text, layer_id = EXCLUDED.layer_id, symbol_set_id = EXCLUDED.symbol_set_id,
             device_type_id = EXCLUDED.device_type_id, product_id = EXCLUDED.product_id, tag = EXCLUDED.tag, status = EXCLUDED.status,
             fields = EXCLUDED.fields, deleted = false, version = markups.version + 1, struct_version = markups.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [doc.id, JSON.stringify([...rows.values()]), userId])
      await q('DELETE FROM page_scales WHERE document_id = $1', [doc.id])
      if (snapScales.length)
        await q(
          `INSERT INTO page_scales (document_id, page, points_per_foot, label, updated_by)
           SELECT $1::uuid, t.page, t.ppf, t.label, $5::uuid FROM unnest($2::int[], $3::float8[], $4::text[]) AS t(page, ppf, label)`,
          [doc.id, snapScales.map(s => s.page), snapScales.map(s => s.points_per_foot), snapScales.map(s => s.label ?? ''), userId])
      return { ...created, label, restored_from: src.revision, removed_markups: removed.length, restored_markups: snapMarkups.length }
    })
    realtime.revisionChanged(doc.id, result.id, result.revision, userId, cid(req))
    realtime.markupsReset(doc.id, userId, cid(req))
    realtime.scalesChanged(doc.id, userId, cid(req))
    return result
  })

  // One revision: meta plus the markups (and photo references / scales) as they were. The newest revision, which is
  // still live, answers with the current markups and `live: true`.
  app.get('/api/documents/:id/revisions/:rid', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'view')
    if (!doc) return
    const { rid } = req.params as any
    const [rev] = UUID_RE.test(String(rid)) ? await db.query(
      `SELECT r.id, r.revision, r.page_count, r.created_at, r.uploaded_by, u.name AS uploaded_by_name, r.kind, r.label, r.note,
              r.markups_snapshot, r.attachments_snapshot, r.scales_snapshot
       FROM document_revisions r LEFT JOIN users u ON u.id = r.uploaded_by WHERE r.document_id = $1 AND r.id = $2`, [doc.id, rid]) : []
    if (!rev) return reply.code(404).send({ error: 'Revision not found' })
    const { markups_snapshot, attachments_snapshot, scales_snapshot, ...meta } = rev
    const access = accessOf(req)
    const snap = markups_snapshot
      ? { live: false, markups: markups_snapshot as any[], attachments: (attachments_snapshot ?? []) as any[], scales: scales_snapshot ?? [] }
      : { live: true, ...(await liveSnapshot(db.query, doc.id)) }
    // A sub only gets their own markups (and those markups' photos); a client gets no internal field values.
    const markups = await visibleMarkups(access, snap.markups)
    const keep = new Set(markups.map((m: any) => m.id))
    return { ...meta, ...snap, markups, attachments: access.role === 'sub' ? snap.attachments.filter((a: any) => keep.has(a.markup_id)) : snap.attachments }
  })

  app.get('/api/documents/:id/revisions/:rid/file', { preHandler: fileAuth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'view')
    if (!doc) return
    const { rid } = req.params as any
    const [rev] = UUID_RE.test(String(rid)) ? await db.query('SELECT file_key FROM document_revisions WHERE document_id = $1 AND id = $2', [doc.id, rid]) : []
    if (!rev) return reply.code(404).send({ error: 'Revision not found' })
    const stream = await storage.open(rev.file_key)
    if (!stream) return reply.code(404).send({ error: 'File missing' })
    fileHeaders(reply, 'application/pdf', `${doc.name}.pdf`)
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    return reply.send(stream)
  })

  // ---- Page tools: every operation writes a new PDF and a new revision; markups, scales and areas follow their pages ----
  const describePages = (pages: number[]) => (pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`)

  async function runPageOp(req: FastifyRequest, reply: FastifyReply, doc: any, op: PageOp, label: string, other?: Uint8Array) {
    const [latest] = await db.query('SELECT id, file_key FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
    const srcBytes = latest ? await storage.read(latest.file_key) : null
    if (!srcBytes) return reply.code(404).send({ error: 'File missing' })
    const src = new Uint8Array(srcBytes)
    let sizes: { width: number; height: number }[], mapping: PageMapping, edited: { bytes: Uint8Array; pageCount: number }
    try {
      sizes = await pageSizes(src)
      mapping = remapPages(op, sizes.length)
      edited = await editPdf(src, op, other)
    } catch (e) {
      if (e instanceof PageOpError) return reply.code(400).send({ error: e.message })
      return reply.code(400).send({ error: `Could not edit that PDF: ${(e as Error).message}` })
    }
    const fileKey = await storage.save('pdf', edited.bytes)
    let deletedMarkups = 0
    let rev: any
    try { rev = await db.transaction(async q => {
      await lockDocument(q, doc.id)
      // The edit was computed from `latest`; if another change landed meanwhile, applying it would silently discard that work.
      const [now] = await q('SELECT id FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
      if (now.id !== latest.id) throw new HttpError(409, 'Plan changed, try again')
      await freezeLatest(q, doc.id)
      if (!isIdentity(mapping)) {
        const from = mapping.map.map((_, i) => i + 1), to = mapping.map.map(n => n ?? 0)
        const gone = from.filter((_, i) => mapping.map[i] === null)
        const [{ n }] = await q<{ n: number }>(
          'SELECT count(*)::int AS n FROM markups m WHERE m.document_id = $1 AND NOT m.deleted AND m.page = ANY($2::int[])', [doc.id, gone])
        deletedMarkups = n
        await q(
          `INSERT INTO markup_events (markup_id, user_id, action, changes)
           SELECT m.id, $3, 'deleted', '{"reason":"page removed"}'::jsonb FROM markups m
           WHERE m.document_id = $1 AND NOT m.deleted AND m.page = ANY($2::int[])`, [doc.id, gone, req.user.id])
        // One statement, so pages that swap or shift never collide with each other.
        await q(
          `UPDATE markups m SET page = CASE WHEN t.np > 0 THEN t.np ELSE m.page END, deleted = (t.np = 0),
             version = m.version + 1, struct_version = m.version + 1, updated_by = $4, updated_at = now()
           FROM unnest($2::int[], $3::int[]) AS t(op, np)
           WHERE m.document_id = $1 AND NOT m.deleted AND m.page = t.op AND t.np <> t.op`, [doc.id, from, to, req.user.id])
        const scales = await q('SELECT page, points_per_foot, label, updated_by FROM page_scales WHERE document_id = $1', [doc.id])
        await q('DELETE FROM page_scales WHERE document_id = $1', [doc.id])
        const kept = scales.map(s => ({ ...s, np: mapping.map[s.page - 1] })).filter(s => s.np)
        if (kept.length)
          await q(
            `INSERT INTO page_scales (document_id, page, points_per_foot, label, updated_by)
             SELECT $1::uuid, t.page, t.ppf, t.label, t.uid FROM unnest($2::int[], $3::float8[], $4::text[], $5::uuid[]) AS t(page, ppf, label, uid)`,
            [doc.id, kept.map(s => s.np), kept.map(s => s.points_per_foot), kept.map(s => s.label), kept.map(s => s.updated_by)])
      }
      if (op.type === 'rotate') {
        const rows = await q<{ id: string; page: number; geometry: any }>(
          'SELECT id, page, geometry FROM markups WHERE document_id = $1 AND NOT deleted AND page = ANY($2::int[])', [doc.id, op.pages])
        const turned = rows.flatMap(m => {
          const size = sizes[m.page - 1]
          return size ? [{ id: m.id, geometry: rotateGeometry(m.geometry, op.degrees, size.width, size.height) }] : []
        })
        if (turned.length)
          await q(
            `UPDATE markups m SET geometry = t.geometry, version = m.version + 1, struct_version = m.version + 1, updated_by = $2, updated_at = now()
             FROM jsonb_to_recordset($1::jsonb) AS t(id uuid, geometry jsonb) WHERE m.id = t.id`,
            [JSON.stringify(turned), req.user.id])
      }
      return insertRevision(q, doc.id, { kind: 'upload', label, note: '', fileKey, pageCount: edited.pageCount, userId: req.user.id })
    }) } catch (e) { void storage.remove(fileKey); throw e }
    realtime.revisionChanged(doc.id, rev.id, rev.revision, req.user.id, cid(req))
    realtime.scalesChanged(doc.id, req.user.id, cid(req))
    return { ...rev, mapping: mapping.map, deleted_markups: deletedMarkups }
  }

  /** Reads the uploaded PDF of a multipart page-tool request. Text fields must come before the file part. */
  async function pageToolUpload(req: FastifyRequest, reply: FastifyReply) {
    const file = await req.file({ limits: { fileSize: runtime.maxUploadBytes } })
    if (!file) { reply.code(400).send({ error: 'No file' }); return null }
    const bytes = new Uint8Array(await file.toBuffer())
    if (file.file.truncated) { reply.code(413).send({ error: `File too large (${runtime.maxUploadMb} MB max)` }); return null }
    if (!isPdf(bytes)) { reply.code(400).send({ error: 'That is not a PDF file' }); return null }
    return { bytes, fields: file.fields as any }
  }

  app.post('/api/documents/:id/pages/insert', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const up = await pageToolUpload(req, reply)
    if (!up) return
    let count: number
    try { count = await countPages(up.bytes) } catch { return reply.code(400).send({ error: 'That is not a readable PDF' }) }
    const at = Number(up.fields.at?.value)
    return runPageOp(req, reply, doc, { type: 'insert', at, count }, `Inserted ${count} page${count === 1 ? '' : 's'} at ${at}`, up.bytes)
  })

  app.post('/api/documents/:id/pages/replace', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const up = await pageToolUpload(req, reply)
    if (!up) return
    // Ranges are checked against the plan's real page count before they are expanded ("1-999999999" is rejected, not expanded).
    const [latest] = await db.query('SELECT page_count FROM document_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [doc.id])
    const pages = parsePageList(String(up.fields.pages?.value ?? ''), latest?.page_count ?? 0)
    if (!pages) return reply.code(400).send({ error: 'Pages must look like 3 or 2-4' })
    return runPageOp(req, reply, doc, { type: 'replace', pages }, `Replaced ${describePages(pages)}`, up.bytes)
  })

  app.post('/api/documents/:id/pages/delete', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const pages = (req.body as any)?.pages
    return runPageOp(req, reply, doc, { type: 'delete', pages }, `Deleted ${Array.isArray(pages) ? describePages(pages) : 'pages'}`)
  })

  app.post('/api/documents/:id/pages/reorder', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    return runPageOp(req, reply, doc, { type: 'reorder', order: (req.body as any)?.order }, 'Reordered pages')
  })

  app.post('/api/documents/:id/pages/rotate', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const b = (req.body ?? {}) as any
    const deg = b.degrees === undefined ? 90 : Number(b.degrees)
    return runPageOp(req, reply, doc, { type: 'rotate', pages: b.pages, degrees: deg }, `Rotated ${Array.isArray(b.pages) ? describePages(b.pages) : 'pages'} ${deg}°`)
  })

  // ---- Page scales ----
  const SCALE_COLUMNS = 'page, points_per_foot, label, updated_at'
  const validPpf = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100000
  const validPage = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v < 1_000_000

  async function upsertScale(docId: string, page: number, ppf: number, label: string, userId: string) {
    const [row] = await db.query(
      `INSERT INTO page_scales (document_id, page, points_per_foot, label, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (document_id, page) DO UPDATE SET points_per_foot = EXCLUDED.points_per_foot,
         label = EXCLUDED.label, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${SCALE_COLUMNS}`, [docId, page, ppf, label, userId])
    return row
  }

  app.get('/api/documents/:id/scales', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'view')
    if (!doc) return
    return db.query(`SELECT ${SCALE_COLUMNS} FROM page_scales WHERE document_id = $1 ORDER BY page`, [doc.id])
  })

  app.put('/api/documents/:id/scales/:page', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const page = Number((req.params as any).page)
    const b = (req.body ?? {}) as any
    if (!validPage(page) || !validPpf(b.points_per_foot))
      return reply.code(400).send({ error: 'A valid page and points_per_foot are required' })
    const row = await upsertScale(doc.id, page, b.points_per_foot, String(b.label ?? ''), req.user.id)
    realtime.scalesChanged(doc.id, req.user.id, cid(req))
    return row
  })

  app.put('/api/documents/:id/scales', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const b = (req.body ?? {}) as any
    if (!validPpf(b.points_per_foot) || !Array.isArray(b.pages) || !b.pages.length || b.pages.length > 5000 || !b.pages.every(validPage))
      return reply.code(400).send({ error: 'points_per_foot and a list of pages are required' })
    const pages = [...new Set<number>(b.pages)].sort((x, y) => x - y)
    const rows = await db.transaction(q => q(
      `INSERT INTO page_scales (document_id, page, points_per_foot, label, updated_by)
       SELECT $1::uuid, p, $3::float8, $4::text, $5::uuid FROM unnest($2::int[]) AS p
       ON CONFLICT (document_id, page) DO UPDATE SET points_per_foot = EXCLUDED.points_per_foot,
         label = EXCLUDED.label, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${SCALE_COLUMNS}`, [doc.id, pages, b.points_per_foot, String(b.label ?? ''), req.user.id]))
    rows.sort((x: any, y: any) => x.page - y.page)
    realtime.scalesChanged(doc.id, req.user.id, cid(req))
    return rows
  })

  app.delete('/api/documents/:id/scales/:page', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'plans.edit')
    if (!doc) return
    const page = Number((req.params as any).page)
    if (!validPage(page)) return reply.code(400).send({ error: 'Bad page' })
    await db.query('DELETE FROM page_scales WHERE document_id = $1 AND page = $2', [doc.id, page])
    realtime.scalesChanged(doc.id, req.user.id, cid(req))
    return { ok: true }
  })

  // ---- Layers ----
  app.get('/api/projects/:id/layers', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'view'))) return
    return db.query('SELECT * FROM layers WHERE project_id = $1 ORDER BY sort, created_at', [id])
  })

  async function layersChanged(projectId: string, req: FastifyRequest) {
    const docs = await db.query<{ id: string }>('SELECT id FROM documents WHERE project_id = $1', [projectId])
    realtime.layersChanged(docs.map(d => d.id), req.user.id, cid(req))
  }

  app.post('/api/projects/:id/layers', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'plans.edit'))) return
    const { name, color } = (req.body ?? {}) as any
    if (!String(name ?? '').trim()) return reply.code(400).send({ error: 'Layer name is required' })
    const [layer] = await db.query(
      `INSERT INTO layers (project_id, name, color, sort)
       VALUES ($1, $2, $3, (SELECT coalesce(max(sort), 0) + 1 FROM layers WHERE project_id = $1)) RETURNING *`,
      [id, String(name).trim(), color || '#e8590c'])
    await layersChanged(id, req)
    return layer
  })

  async function layerWithAccess(req: FastifyRequest, reply: FastifyReply, cap: Cap) {
    const { id } = req.params as any
    const [layer] = await db.query('SELECT * FROM layers WHERE id = $1', [id])
    if (!layer) { reply.code(404).send({ error: 'Not found' }); return null }
    if (!(await requireCap(req, reply, layer.project_id, cap))) return null
    return layer
  }

  app.patch('/api/layers/:id', { preHandler: auth }, async (req, reply) => {
    const layer = await layerWithAccess(req, reply, 'plans.edit')
    if (!layer) return
    const { name, color } = (req.body ?? {}) as any
    const [updated] = await db.query(
      'UPDATE layers SET name = $1, color = $2 WHERE id = $3 RETURNING *',
      [String(name ?? layer.name).trim() || layer.name, color ?? layer.color, layer.id])
    await layersChanged(layer.project_id, req)
    return updated
  })

  app.delete('/api/layers/:id', { preHandler: auth }, async (req, reply) => {
    const layer = await layerWithAccess(req, reply, 'plans.delete')
    if (!layer) return
    await db.query('DELETE FROM layers WHERE id = $1', [layer.id])
    await layersChanged(layer.project_id, req)
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
        // Internal fields are hidden from clients (the role).
        ...(f.internal === true ? { internal: true } : {}),
      })) : []
    const icon = String(b.icon ?? '')
    if (icon && !/^data:image\/(svg\+xml|png|jpeg|webp)[;,]/.test(icon)) return null
    if (icon.length > 300_000) return null
    return { name, tag_prefix, fields, icon, color: String(b.color || '#868e96'), has_fov: !!b.has_fov }
  }

  app.get('/api/symbol-sets', { preHandler: auth }, async (req) => {
    const rows = await db.query('SELECT * FROM symbol_sets WHERE NOT archived ORDER BY sort, created_at')
    return (await orgVisibility(req.user)).internal ? rows : rows.map((r: any) => ({ ...r, fields: withoutInternalDefs(r.fields) }))
  })

  app.post('/api/symbol-sets', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const s = cleanSymbolSet(req.body)
    if (!s) return reply.code(400).send({ error: 'Name, tag prefix and a valid icon are required' })
    const [row] = await db.query(
      `INSERT INTO symbol_sets (name, color, tag_prefix, icon, fields, has_fov, sort)
       VALUES ($1,$2,$3,$4,$5,$6,(SELECT coalesce(max(sort),0)+1 FROM symbol_sets)) RETURNING *`,
      [s.name, s.color, s.tag_prefix, s.icon, JSON.stringify(s.fields), s.has_fov])
    realtime.symbolSetsChanged(req.user.id, cid(req))
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
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return row
  })

  // Archive rather than delete so existing device markups keep their set
  app.delete('/api/symbol-sets/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    await db.query('UPDATE symbol_sets SET archived = true WHERE id = $1', [(req.params as any).id])
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return { ok: true }
  })

  // ---- Catalog: device types and products ----
  const cleanFields = (v: any) => cleanSymbolSet({ name: 'x', tag_prefix: 'x', fields: v })?.fields ?? []
  const numOr0 = (v: any) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0 }
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  function cleanDeviceType(b: any) {
    const name = String(b?.name ?? '').trim()
    if (!name) return null
    const icon = String(b.icon ?? '')
    if (icon && (!/^data:image\/(svg\+xml|png|jpeg|webp)[;,]/.test(icon) || icon.length > 300_000)) return null
    const prefix = String(b.tag_prefix ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    // Default coverage for new devices of this type: { on, angle 1-360, range_ft > 0 }, or null for none. undefined = not sent.
    let coverage: { on: boolean; angle: number; range_ft: number } | null | undefined
    if (b.coverage === null) coverage = null
    else if (b.coverage && typeof b.coverage === 'object') {
      const angle = Math.round(Number(b.coverage.angle)), range = Number(b.coverage.range_ft)
      coverage = {
        on: b.coverage.on === true,
        angle: Number.isFinite(angle) ? Math.min(360, Math.max(1, angle)) : 90,
        range_ft: Number.isFinite(range) && range > 0 ? Math.min(10000, Math.round(range * 100) / 100) : 20,
      }
    }
    // Mount shape: 'ceiling' | 'wall' | 'square'. Not sent = keep the stored value (update) or 'ceiling' (create); anything else is invalid.
    let mount: 'ceiling' | 'wall' | 'square' | undefined
    if (b.mount !== undefined && b.mount !== null) {
      if (b.mount !== 'ceiling' && b.mount !== 'wall' && b.mount !== 'square') return null
      mount = b.mount
    }
    return { name, icon, tag_prefix: prefix || null, fields: cleanFields(b.fields), coverage, mount }
  }

  function cleanProduct(b: any) {
    const kind = b?.kind === 'accessory' ? 'accessory' : 'device'
    const manufacturer = String(b?.manufacturer ?? '').trim(), model = String(b?.model ?? '').trim()
    const name = String(b?.name ?? '').trim()
    if (!manufacturer && !model && !name) return null
    const accessories = (Array.isArray(b.accessories) ? b.accessories : []).map((a: any) => {
      const qty = Math.max(1, Math.round(Number(a?.qty) || 1))
      if (a?.product_id && uuidRe.test(String(a.product_id))) return { product_id: String(a.product_id), qty }
      const an = String(a?.name ?? '').trim()
      return an ? { name: an, unit_cost: numOr0(a.unit_cost), labor_hours: numOr0(a.labor_hours), qty } : null
    }).filter(Boolean)
    const df = b.default_fields && typeof b.default_fields === 'object' && !Array.isArray(b.default_fields) ? b.default_fields : {}
    return {
      kind, manufacturer, model, name, spec_url: String(b.spec_url ?? '').trim(),
      unit_cost: numOr0(b.unit_cost), labor_hours: numOr0(b.labor_hours),
      default_fields: df, accessories, active: b.active !== false,
    }
  }

  // numeric columns come back as strings from Postgres; the client wants numbers
  const productOut = (r: any) => ({ ...r, unit_cost: Number(r.unit_cost), labor_hours: Number(r.labor_hours) })

  // The catalog is shared by every project, so what a person sees is decided across all their memberships (see orgVisibility):
  // unit costs and labor hours come back only for app admins and for people whose role in at least one project can see costs
  // (admin, pm, editors while that project's "editors see costs" is on, and viewers); internal field definitions only for
  // people who are not clients everywhere.
  app.get('/api/catalog', { preHandler: auth }, async (req) => {
    const vis = await orgVisibility(req.user)
    const types = await db.query('SELECT * FROM device_types WHERE NOT archived ORDER BY symbol_set_id, sort, created_at')
    const products = (await db.query('SELECT * FROM products ORDER BY manufacturer, model, created_at')).map(productOut)
    // Archived types stay in the list (flagged) so cables already drawn with them keep their name and colour
    const cable_types = await db.query('SELECT id, name, color, sort, archived FROM cable_types ORDER BY sort, created_at')
    return {
      device_types: vis.internal ? types : types.map((t: any) => ({ ...t, fields: withoutInternalDefs(t.fields) })),
      products: vis.costs ? products : products.map(stripProductCosts),
      cable_types,
      can_see_costs: vis.costs,
    }
  })

  // ---- Cable types (admins manage; everyone with the catalog reads them): name + canvas colour ----
  const cleanCableType = (b: any) => {
    const name = String(b?.name ?? '').trim().slice(0, 60)
    const color = String(b?.color ?? '').trim()
    if (!name || (color && !/^#[0-9a-fA-F]{6}$/.test(color))) return null
    return { name, color: color || '#e03131' }
  }
  app.post('/api/cable-types', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const t = cleanCableType(req.body)
    if (!t) return reply.code(400).send({ error: 'A name and a colour like #1971c2 are required' })
    const [row] = await db.query(
      'INSERT INTO cable_types (name, color, sort) VALUES ($1,$2,(SELECT coalesce(max(sort),0)+1 FROM cable_types)) RETURNING id, name, color, sort, archived', [t.name, t.color])
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return row
  })
  app.put('/api/cable-types/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const t = cleanCableType(req.body)
    const id = (req.params as any).id
    if (!t || !uuidRe.test(String(id))) return reply.code(400).send({ error: 'A name and a colour like #1971c2 are required' })
    const [row] = await db.query('UPDATE cable_types SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color, sort, archived', [t.name, t.color, id])
    if (!row) return reply.code(404).send({ error: 'Not found' })
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return row
  })
  // Archived, never deleted: cables already drawn with the type keep their name and colour
  app.delete('/api/cable-types/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const id = (req.params as any).id
    if (!uuidRe.test(String(id))) return reply.code(400).send({ error: 'Bad id' })
    await db.query('UPDATE cable_types SET archived = true WHERE id = $1', [id])
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return { ok: true }
  })

  // ---- Standard device library: symbol sets and device types for the built-in icon set (admins; only ever adds or fills blanks) ----
  app.get('/api/catalog/standard-library', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    return previewLibrary(db)
  })
  app.post('/api/catalog/standard-library', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const result = await installLibrary(db)
    if (result.setsCreated || result.typesAdded || result.typesUpdated || result.cableTypesAdded) realtime.symbolSetsChanged(req.user.id, cid(req))
    return result
  })

  // ---- Revu converter mappings (one set per organization: Revu signature -> device type / product) ----
  const REVU_ACTIONS = ['device', 'plain', 'skip']
  const listRevuMappings = () => db.query(
    'SELECT signature, symbol_set_id, device_type_id, product_id, action, updated_at FROM revu_mappings ORDER BY signature')

  app.get('/api/revu-mappings', { preHandler: auth }, async () => listRevuMappings())

  // Mappings are shared by the whole organization, so only app admins may change them.
  app.put('/api/revu-mappings', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const list = (req.body as any)?.mappings
    if (!Array.isArray(list) || list.length > 2000) return reply.code(400).send({ error: 'mappings must be a list' })
    const id = (v: unknown) => (v ? String(v).toLowerCase() : null)
    const clean = new Map<string, { signature: string; set: string | null; type: string | null; product: string | null; action: string }>()
    for (const m of list) {
      const signature = String(m?.signature ?? '').trim()
      const action = String(m?.action ?? 'device')
      if (!signature || signature.length > 300 || !REVU_ACTIONS.includes(action)) return reply.code(400).send({ error: 'Bad mapping' })
      const set = id(m.symbol_set_id), type = id(m.device_type_id), product = id(m.product_id)
      for (const v of [set, type, product]) if (v && !uuidRe.test(v)) return reply.code(400).send({ error: 'Bad id' })
      const dev = action === 'device'
      clean.set(signature, { signature, set: dev ? set : null, type: dev ? type : null, product: dev ? product : null, action }) // a repeated signature: last wins
    }
    // Referenced ids are checked with three queries in total, not three per mapping.
    const devices = [...clean.values()].filter(c => c.action === 'device')
    const ids = (pick: (c: (typeof devices)[number]) => string | null) => [...new Set(devices.map(pick).filter((v): v is string => !!v))]
    const sets = new Set((await db.query<{ id: string }>('SELECT id FROM symbol_sets WHERE id = ANY($1::uuid[])', [ids(c => c.set)])).map(r => r.id))
    const types = new Map((await db.query<{ id: string; symbol_set_id: string }>(
      'SELECT id, symbol_set_id FROM device_types WHERE id = ANY($1::uuid[])', [ids(c => c.type)])).map(r => [r.id, r.symbol_set_id]))
    const products = new Set((await db.query<{ id: string }>('SELECT id FROM products WHERE id = ANY($1::uuid[])', [ids(c => c.product)])).map(r => r.id))
    for (const c of devices) {
      if (!c.set) return reply.code(400).send({ error: 'A device mapping needs a symbol set' })
      if (!sets.has(c.set)) return reply.code(400).send({ error: 'Unknown symbol set' })
      if (c.type && types.get(c.type) !== c.set) return reply.code(400).send({ error: 'Unknown device type' })
      if (c.product && !products.has(c.product)) return reply.code(400).send({ error: 'Unknown product' })
    }
    const rows = [...clean.values()]
    if (rows.length)
      await db.query(
        `INSERT INTO revu_mappings (signature, symbol_set_id, device_type_id, product_id, action)
         SELECT * FROM unnest($1::text[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[])
         ON CONFLICT (signature) DO UPDATE SET symbol_set_id = EXCLUDED.symbol_set_id, device_type_id = EXCLUDED.device_type_id,
           product_id = EXCLUDED.product_id, action = EXCLUDED.action, updated_at = now()`,
        [rows.map(c => c.signature), rows.map(c => c.set), rows.map(c => c.type), rows.map(c => c.product), rows.map(c => c.action)])
    return listRevuMappings()
  })

  app.post('/api/symbol-sets/:id/device-types', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const t = cleanDeviceType(req.body)
    if (!t) return reply.code(400).send({ error: 'Name and a valid icon are required' })
    const [set] = await db.query('SELECT id FROM symbol_sets WHERE id = $1', [(req.params as any).id])
    if (!set) return reply.code(404).send({ error: 'Not found' })
    const [row] = await db.query(
      `INSERT INTO device_types (symbol_set_id, name, icon, tag_prefix, fields, coverage, mount, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT coalesce(max(sort),0)+1 FROM device_types WHERE symbol_set_id = $1)) RETURNING *`,
      [set.id, t.name, t.icon, t.tag_prefix, JSON.stringify(t.fields), t.coverage ? JSON.stringify(t.coverage) : null, t.mount ?? 'ceiling'])
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return row
  })

  app.put('/api/device-types/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const t = cleanDeviceType(req.body)
    if (!t) return reply.code(400).send({ error: 'Name and a valid icon are required' })
    const b = req.body as any
    let defaultId: string | null = null
    if (b.default_product_id) {
      const [p] = await db.query('SELECT id FROM products WHERE id = $1 AND device_type_id = $2', [b.default_product_id, (req.params as any).id])
      if (!p) return reply.code(400).send({ error: 'Default product must belong to this type' })
      defaultId = p.id
    }
    const [row] = await db.query(
      `UPDATE device_types SET name=$1, icon=$2, tag_prefix=$3, fields=$4, default_product_id=$5,
         coverage = CASE WHEN $7::boolean THEN $8::jsonb ELSE coverage END,
         mount = coalesce($9::text, mount) WHERE id=$6 RETURNING *`,
      [t.name, t.icon, t.tag_prefix, JSON.stringify(t.fields), defaultId, (req.params as any).id,
        t.coverage !== undefined, t.coverage ? JSON.stringify(t.coverage) : null, t.mount ?? null])
    if (!row) return reply.code(404).send({ error: 'Not found' })
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return row
  })

  // Reorder a set's device types: body { ids } lists them in the wanted order (unlisted types keep their place after them)
  app.put('/api/symbol-sets/:id/device-types/order', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const setId = (req.params as any).id
    const ids = (req.body as any)?.ids
    if (!UUID_RE.test(String(setId)) || !Array.isArray(ids) || ids.some((i: unknown) => typeof i !== 'string' || !UUID_RE.test(i)) || new Set(ids).size !== ids.length)
      return reply.code(400).send({ error: 'ids must be a list of device type ids' })
    const rows = await db.query<{ id: string }>('SELECT id FROM device_types WHERE symbol_set_id = $1 ORDER BY sort, created_at', [setId])
    const have = new Set(rows.map(r => r.id))
    if (ids.some((i: string) => !have.has(i))) return reply.code(400).send({ error: 'Unknown device type for this symbol set' })
    const order = [...ids, ...rows.map(r => r.id).filter(i => !ids.includes(i))]
    await db.transaction(async q => { for (let i = 0; i < order.length; i++) await q('UPDATE device_types SET sort = $1 WHERE id = $2', [i + 1, order[i]]) })
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return { ok: true, order }
  })

  // Archive so existing device markups keep their type
  app.delete('/api/device-types/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    await db.query('UPDATE device_types SET archived = true WHERE id = $1', [(req.params as any).id])
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return { ok: true }
  })

  app.post('/api/products', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const p = cleanProduct(req.body)
    if (!p) return reply.code(400).send({ error: 'Manufacturer, model or name is required' })
    let typeId: string | null = null
    if (p.kind === 'device') {
      typeId = (req.body as any).device_type_id ?? null
      const [t] = typeId && uuidRe.test(typeId) ? await db.query('SELECT id FROM device_types WHERE id = $1', [typeId]) : []
      if (!t) return reply.code(400).send({ error: 'Unknown device type' })
    }
    const [row] = await db.query(
      `INSERT INTO products (device_type_id, kind, manufacturer, model, name, spec_url, unit_cost, labor_hours, default_fields, accessories, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [typeId, p.kind, p.manufacturer, p.model, p.name, p.spec_url, p.unit_cost, p.labor_hours,
        JSON.stringify(p.default_fields), JSON.stringify(p.accessories), p.active])
    if (typeId) await db.query('UPDATE device_types SET default_product_id = $1 WHERE id = $2 AND default_product_id IS NULL', [row.id, typeId])
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return productOut(row)
  })

  app.put('/api/products/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const p = cleanProduct(req.body)
    if (!p) return reply.code(400).send({ error: 'Manufacturer, model or name is required' })
    const [row] = await db.query(
      `UPDATE products SET manufacturer=$1, model=$2, name=$3, spec_url=$4, unit_cost=$5, labor_hours=$6,
         default_fields=$7, accessories=$8, active=$9 WHERE id=$10 RETURNING *`,
      [p.manufacturer, p.model, p.name, p.spec_url, p.unit_cost, p.labor_hours,
        JSON.stringify(p.default_fields), JSON.stringify(p.accessories), p.active, (req.params as any).id])
    if (!row) return reply.code(404).send({ error: 'Not found' })
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return productOut(row)
  })

  // Hard delete only when unused; otherwise deactivate so BOMs of existing devices stay correct
  app.delete('/api/products/:id', { preHandler: auth }, async (req, reply) => {
    if (!req.user.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const id = (req.params as any).id
    const [used] = await db.query('SELECT count(*)::int AS n FROM markups WHERE product_id = $1', [id])
    if (used.n > 0) {
      await db.query('UPDATE products SET active = false WHERE id = $1', [id])
    } else {
      await db.query('UPDATE device_types SET default_product_id = NULL WHERE default_product_id = $1', [id])
      await db.query('DELETE FROM products WHERE id = $1', [id])
    }
    realtime.symbolSetsChanged(req.user.id, cid(req))
    return { ok: true, deactivated: used.n > 0 }
  })

  /**
   * Next free tag for a prefix across the whole project, e.g. CAM-07. The project's tag format (CAM-01 / CAM1 / CAM-001)
   * and gap filling decide the shape and which number is next. Call under the project+prefix advisory lock.
   */
  async function nextTag(q: Q, padding: number, projectId: string, prefix: string, ps: Pick<ProjectSettings, 'tag_format' | 'tag_fill_gaps'>) {
    const rows = await q<{ tag: string }>(
      `SELECT m.tag FROM markups m JOIN documents d ON d.id = m.document_id
       WHERE d.project_id = $1 AND NOT m.deleted AND left(m.tag, $3) = $2`, [projectId, prefix, prefix.length])
    const used = rows.map(r => tagNumber(r.tag, prefix)).filter((n): n is number => n !== null)
    return formatTag(prefix, nextNumber(used, ps.tag_fill_gaps), ps.tag_format, padding)
  }

  // ---- Markups ----
  const MARKUP_COLUMNS = 'id, document_id, page, type, geometry, style, text, layer_id, symbol_set_id, device_type_id, product_id, tag, status, fields, version, created_by, updated_by, created_at, updated_at'
  /** Field keys every device has (the web app's HARDWARE_FIELDS), with the labels used in "missing" messages. */
  const HARDWARE_LABELS: Record<string, string> = { manufacturer: 'Manufacturer', model: 'Model #', serial: 'Serial #', firmware: 'Firmware' }
  const projectSettingsOf = async (projectId: string) => readProjectSettings((await db.query('SELECT settings FROM projects WHERE id = $1', [projectId]))[0]?.settings)

  app.get('/api/documents/:id/markups', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'view')
    if (!doc) return
    const cols = MARKUP_COLUMNS.split(', ').map(c => `m.${c}`).join(', ')
    const rows = await db.query(
      `SELECT ${cols}, cu.name AS created_by_name, uu.name AS updated_by_name
       FROM markups m LEFT JOIN users cu ON cu.id = m.created_by LEFT JOIN users uu ON uu.id = m.updated_by
       WHERE m.document_id = $1 AND NOT m.deleted ORDER BY m.created_at`, [doc.id])
    return visibleMarkups(accessOf(req), rows)
  })

  app.get('/api/projects/:id/markups', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'view'))) return
    const type = (req.query as any)?.type
    const params: any[] = [id]
    let typeClause = ''
    if (typeof type === 'string' && type) { params.push(type); typeClause = ' AND m.type = $2' }
    // Optional paging: ?limit=N (1..2000) [&cursor=<from the previous page's `next`>]. Without limit the answer is the plain array.
    const q = (req.query as any) ?? {}
    let paged: { limit: number; offset: number } | null = null
    let pageClause = ''
    if (q.limit !== undefined) {
      const limit = Number(q.limit), offset = q.cursor === undefined || q.cursor === '' ? 0 : Number(q.cursor)
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000 || !Number.isInteger(offset) || offset < 0)
        return reply.code(400).send({ error: 'limit must be 1-2000 and cursor a value returned by a previous page' })
      paged = { limit, offset }
      pageClause = ` LIMIT ${limit + 1} OFFSET ${offset}`
    }
    const cols = MARKUP_COLUMNS.split(', ').map(c => `m.${c}`).join(', ')
    const rows = await db.query(
      `SELECT ${cols}, cu.name AS created_by_name, uu.name AS updated_by_name, d.name AS document_name,
              (SELECT count(*)::int FROM attachments a WHERE a.markup_id = m.id) AS photo_count
       FROM markups m JOIN documents d ON d.id = m.document_id
       LEFT JOIN users cu ON cu.id = m.created_by LEFT JOIN users uu ON uu.id = m.updated_by
       WHERE d.project_id = $1 AND NOT m.deleted${typeClause}
       ORDER BY d.name, m.page, m.created_at, m.id${pageClause}`, params)
    if (!paged) return visibleMarkups(accessOf(req), rows)
    // Paged: ask for one extra row to know whether another page exists. The cursor is the offset of the next page.
    const more = rows.length > paged.limit
    return { items: await visibleMarkups(accessOf(req), more ? rows.slice(0, paged.limit) : rows), next: more ? String(paged.offset + paged.limit) : null }
  })

  app.get('/api/projects/:id/scales', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as any
    if (!(await requireCap(req, reply, id, 'view'))) return
    return db.query(
      `SELECT s.document_id, s.page, s.points_per_foot, s.label
       FROM page_scales s JOIN documents d ON d.id = s.document_id
       WHERE d.project_id = $1 ORDER BY d.name, s.page`, [id])
  })

  // ---- Change history ----
  const stable = (v: any): string => {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
    return JSON.stringify(v ?? null)
  }
  const same = (a: any, b: any) => stable(a) === stable(b)
  const emptyToNull = (v: any) => (v === undefined || v === '' ? null : v)

  /** Describes what changed between two markup states. Empty object = nothing changed. */
  function diffMarkup(prev: any, next: any) {
    const changes: Record<string, any> = {}
    const pf = prev.fields ?? {}, nf = next.fields ?? {}
    for (const k of new Set([...Object.keys(pf), ...Object.keys(nf)])) {
      const from = emptyToNull(pf[k]), to = emptyToNull(nf[k])
      if (!same(from, to)) changes[`fields.${k}`] = { from, to }
    }
    for (const k of ['status', 'tag', 'text', 'layer_id', 'symbol_set_id', 'device_type_id', 'product_id'])
      if ((prev[k] ?? null) !== (next[k] ?? null)) changes[k] = { from: prev[k] ?? null, to: next[k] ?? null }
    if (!same(prev.geometry, next.geometry)) changes.geometry = true
    if (!same(prev.style, next.style)) changes.style = true
    return changes
  }

  async function recordEvent(markupId: string, userId: string, action: string, changes: Record<string, any> = {}) {
    if (action === 'updated') {
      // The client saves on every keystroke: fold quick successive edits by one user into one event.
      const [last] = await db.query(
        `SELECT id, user_id, action, changes, at > now() - interval '2 minutes' AS recent
         FROM markup_events WHERE markup_id = $1 ORDER BY at DESC, id DESC LIMIT 1`, [markupId])
      if (last && last.action === 'updated' && last.user_id === userId && last.recent) {
        const merged: Record<string, any> = { ...last.changes }
        for (const [k, v] of Object.entries(changes)) {
          const old = merged[k]
          merged[k] = old && typeof old === 'object' && typeof v === 'object' ? { from: old.from, to: (v as any).to } : v
        }
        for (const [k, v] of Object.entries(merged))
          if (v && typeof v === 'object' && same((v as any).from, (v as any).to)) delete merged[k]
        if (Object.keys(merged).length === 0) {
          await db.query('DELETE FROM markup_events WHERE id = $1', [last.id])
        } else {
          await db.query('UPDATE markup_events SET changes = $1, at = now() WHERE id = $2', [JSON.stringify(merged), last.id])
        }
        return
      }
    }
    await db.query('INSERT INTO markup_events (markup_id, user_id, action, changes) VALUES ($1,$2,$3,$4)',
      [markupId, userId, action, JSON.stringify(changes)])
  }

  app.get('/api/markups/:markupId/history', { preHandler: auth }, async (req, reply) => {
    const { markupId } = req.params as any
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(markupId)))
      return reply.code(404).send({ error: 'Not found' })
    const [m] = await db.query(
      'SELECT d.project_id FROM markups m JOIN documents d ON d.id = m.document_id WHERE m.id = $1', [markupId])
    if (!m) return reply.code(404).send({ error: 'Not found' })
    const access = await requireCap(req, reply, m.project_id, 'view')
    if (!access) return
    if (access.role === 'sub') {
      const [mk] = await db.query('SELECT symbol_set_id, layer_id FROM markups WHERE id = $1', [markupId])
      if (!mk || !canSeeMarkup(access, mk)) return reply.code(404).send({ error: 'Not found' })
    }
    const rows = await db.query(
      `SELECT e.id, e.at, e.action, e.changes, u.id AS uid, u.name AS uname, u.email AS uemail
       FROM markup_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.markup_id = $1 ORDER BY e.at DESC, e.id DESC`, [markupId])
    return rows.map((r: any) => ({
      id: String(r.id), at: r.at, action: r.action, changes: r.changes,
      user: r.uid ? { id: r.uid, name: r.uname, email: r.uemail } : null,
    }))
  })

  // Upsert by client-generated id. Last write wins; version increases on every save. Exceptions (only when the client
  // sends `base_version`, the version its edit was based on): if the markup was deleted, or moved/rotated/restored by a
  // page operation, after that version, the edit is NOT applied and the answer is 409 { conflict: true, current } so
  // the client can adopt the server's page/geometry. `restore: true` (undo of a delete) skips that check.
  /**
   * True when the request body changes nothing but fields, status and notes (notes live in `fields`) compared with the stored row:
   * what field and sub users are allowed to send. Blank ids/tag in the body mean "unchanged".
   */
  function onlyFieldChanges(existing: any, b: any): boolean {
    const id = (v: unknown) => (v ? String(v).toLowerCase() : null)
    return b.page === existing.page && String(b.type) === existing.type
      && same(b.geometry, existing.geometry) && same(b.style ?? {}, existing.style ?? {})
      && String(b.text ?? '') === (existing.text ?? '')
      && id(b.layer_id) === id(existing.layer_id) && id(b.symbol_set_id) === id(existing.symbol_set_id)
      && id(b.device_type_id) === id(existing.device_type_id) && id(b.product_id) === id(existing.product_id)
      && (String(b.tag ?? '').trim() === '' || String(b.tag).trim() === existing.tag)
  }

  app.put('/api/documents/:id/markups/:markupId', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'markup.fields')
    if (!doc) return
    const access = accessOf(req)
    // Field and sub users can only edit what already exists: no creating, moving, resizing or restoring.
    const restricted = !accessCan(access, 'markup.geometry')
    if (!restricted && !accessCan(access, 'markup.create')) return reply.code(403).send({ error: 'Not allowed' })
    const { markupId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!/^[0-9a-f-]{36}$/i.test(markupId)) return reply.code(400).send({ error: 'Bad markup id' })
    if (!b.type || !b.geometry || !Number.isInteger(b.page) || b.page < 1 || b.page > 1_000_000)
      return reply.code(400).send({ error: 'type, page and geometry are required' })
    // References that were deleted meanwhile fall back to null (like a revision restore does) instead of failing
    // the whole save: a permanent failure here would also strand the photos queued behind it.
    let layerId: string | null = null
    if (b.layer_id && uuidRe.test(String(b.layer_id))) {
      const [layer] = await db.query('SELECT project_id FROM layers WHERE id = $1', [b.layer_id])
      if (layer && layer.project_id === doc.project_id) layerId = b.layer_id
    }
    const status = String(b.status ?? '')
    const ps = await projectSettingsOf(doc.project_id)
    const clientTag = String(b.tag ?? '').trim().slice(0, 100)
    let prefix: string | null = null
    let deviceTypeId: string | null = null, productId: string | null = null
    /** Field definitions that apply to this device: set and type fields (hardware fields apply to every device). */
    const defs = new Map<string, string>(Object.entries(HARDWARE_LABELS))
    if (b.symbol_set_id) {
      const [set] = uuidRe.test(String(b.symbol_set_id)) ? await db.query('SELECT tag_prefix, fields FROM symbol_sets WHERE id = $1', [b.symbol_set_id]) : []
      if (!set) return reply.code(400).send({ error: 'Unknown symbol set' })
      prefix = ps.tag_prefixes[String(b.symbol_set_id).toLowerCase()] ?? set.tag_prefix
      for (const f of Array.isArray(set.fields) ? set.fields : []) if (f?.key) defs.set(String(f.key), String(f.label || f.key))
      if (b.device_type_id) {
        const [dt] = uuidRe.test(String(b.device_type_id))
          ? await db.query('SELECT id, tag_prefix, fields FROM device_types WHERE id = $1 AND symbol_set_id = $2', [b.device_type_id, b.symbol_set_id]) : []
        if (!dt) return reply.code(400).send({ error: 'Unknown device type' })
        deviceTypeId = dt.id
        if (dt.tag_prefix) prefix = dt.tag_prefix
        for (const f of Array.isArray(dt.fields) ? dt.fields : []) if (f?.key) defs.set(String(f.key), String(f.label || f.key))
      }
      if (b.product_id) {
        const [pr] = uuidRe.test(String(b.product_id)) ? await db.query('SELECT id FROM products WHERE id = $1', [b.product_id]) : []
        productId = pr ? pr.id : null
      }
    }
    const fields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : {}
    const padding = (await getSection(db, 'tags')).padding
    const baseVersion = Number.isInteger(b.base_version) ? (b.base_version as number) : null
    const restore = b.restore === true
    const out = await db.transaction(async q => {
      // Same-id requests (a replayed retry racing the original) run one after the other, and the existing row is read
      // under that lock, so the second one sees the first one's tag instead of drawing another number.
      await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`markup|${markupId}`])
      const [existing] = await q('SELECT * FROM markups WHERE id = $1 FOR UPDATE', [markupId])
      if (existing && existing.document_id !== doc.id) throw new HttpError(409, 'Markup belongs to another document')
      // A status must be one of the project's (a device may keep one that was removed from the list since).
      if (status !== '' && !ps.statuses.some(s => s.key === status) && existing?.status !== status) throw new HttpError(400, 'Bad status')
      if (restricted) {
        if (!existing || existing.deleted) throw new HttpError(403, 'You cannot add markups')
        if (!canSeeMarkup(access, existing)) throw new HttpError(403, 'Not allowed')
        if (!onlyFieldChanges(existing, b)) throw new HttpError(403, 'You can only change device fields, status and notes')
      }
      if (existing && baseVersion !== null && !restore && Number(existing.struct_version ?? 0) > baseVersion) {
        const cols = MARKUP_COLUMNS.split(', ').map(c => `m.${c}`).join(', ')
        const [current] = await q(
          `SELECT ${cols}, m.deleted, cu.name AS created_by_name, uu.name AS updated_by_name
           FROM markups m LEFT JOIN users cu ON cu.id = m.created_by LEFT JOIN users uu ON uu.id = m.updated_by
           WHERE m.id = $1`, [markupId])
        return { conflict: current as any }
      }
      let tag = restricted ? existing.tag : clientTag
      let autoPrefix: string | null = null
      // An update that leaves the tag blank keeps the one it has; only a new device draws the next number.
      if (!restricted && prefix !== null && !tag) {
        if (existing && !existing.deleted && existing.tag && existing.symbol_set_id === b.symbol_set_id) tag = existing.tag
        else autoPrefix = prefix
      }
      // A client-chosen tag that is new to this markup must not collide with another one in the project.
      const checkTag = autoPrefix === null && tag !== '' && (!existing || existing.deleted || existing.tag !== tag)
      // One lock per project+prefix, held until commit, so two simultaneous creates cannot draw the same number.
      if (autoPrefix !== null || checkTag)
        await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`${doc.project_id}|${autoPrefix ?? tagPrefixFromTag(tag, ps.tag_format)}`])
      if (autoPrefix !== null) tag = await nextTag(q, padding, doc.project_id, autoPrefix, ps)
      else if (checkTag) {
        const dup = await q(
          `SELECT 1 FROM markups m JOIN documents d ON d.id = m.document_id
           WHERE d.project_id = $1 AND NOT m.deleted AND m.tag = $2 AND m.id <> $3 LIMIT 1`, [doc.project_id, tag, markupId])
        // Taken by another markup (typed offline, or by someone else meanwhile): renumber instead of failing the save for good.
        // The client adopts the tag in the answer.
        if (dup.length) tag = await nextTag(q, padding, doc.project_id, tagPrefixFromTag(tag, ps.tag_format), ps)
      }
      // Required fields: only when the device moves into a status that has requirements (so devices already in that status stay editable).
      if (ps.required[status]?.length && (!existing || existing.deleted || existing.status !== status)) {
        const [{ n }] = await q<{ n: number }>('SELECT count(*)::int AS n FROM attachments WHERE markup_id = $1', [markupId])
        // Photos taken offline are queued behind the markup save, so the client says how many are waiting.
        const queued = Number.isInteger(b.pending_photos) ? Math.min(Math.max(b.pending_photos, 0), 50) : 0
        const missing = missingRequired(ps, { status, fields, tag, photoCount: n + queued, applicable: new Set(defs.keys()) })
        if (missing.length) {
          const label = (k: string) => (k === 'photo' ? 'a photo' : k === 'tag' ? 'a tag' : defs.get(k) ?? k)
          const name = ps.statuses.find(s => s.key === status)?.label ?? status
          throw new HttpError(422, `Cannot set ${name}: missing ${missing.map(label).join(', ')}`,
            { missing: missing.map(k => ({ key: k, label: label(k) })), status })
        }
      }
      const [r] = await q(
      `INSERT INTO markups (id, document_id, page, type, geometry, style, text, layer_id, symbol_set_id, tag, status, fields, created_by, updated_by, device_type_id, product_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET page = EXCLUDED.page, type = EXCLUDED.type, geometry = EXCLUDED.geometry,
         style = EXCLUDED.style, text = EXCLUDED.text, layer_id = EXCLUDED.layer_id,
         symbol_set_id = EXCLUDED.symbol_set_id, device_type_id = EXCLUDED.device_type_id, product_id = EXCLUDED.product_id, tag = EXCLUDED.tag, status = EXCLUDED.status, fields = EXCLUDED.fields,
         deleted = false, version = markups.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${MARKUP_COLUMNS}`,
      // A restricted user's row keeps every stored value except fields and status (checked above).
      restricted
        ? [markupId, doc.id, existing.page, existing.type, JSON.stringify(existing.geometry), JSON.stringify(existing.style ?? {}),
          existing.text, existing.layer_id, existing.symbol_set_id, tag, status, JSON.stringify(fields), req.user.id, existing.device_type_id, existing.product_id]
        : [markupId, doc.id, b.page, String(b.type), JSON.stringify(b.geometry), JSON.stringify(b.style ?? {}),
          String(b.text ?? ''), layerId, b.symbol_set_id || null, tag, status, JSON.stringify(fields), req.user.id, deviceTypeId, productId])
      return { row: r, existing }
    })
    if ('conflict' in out) {
      return reply.code(409).send({
        error: out.conflict.deleted ? 'This markup was deleted by someone else' : 'This markup was moved by a page change', conflict: true, current: out.conflict })
    }
    const { row, existing } = out
    if (!existing) await recordEvent(markupId, req.user.id, 'created')
    else if (existing.deleted) await recordEvent(markupId, req.user.id, 'restored')
    else {
      const changes = diffMarkup(existing, row)
      if (Object.keys(changes).length) await recordEvent(markupId, req.user.id, 'updated', changes)
    }
    const [names] = await db.query(
      `SELECT (SELECT name FROM users WHERE id = $1) AS created_by_name, (SELECT name FROM users WHERE id = $2) AS updated_by_name`,
      [row.created_by, row.updated_by])
    realtime.markupChanged(doc.id, { ...row, ...names }, req.user.id, cid(req), realtime.hasRole(doc.id, 'client') ? await internalFieldKeys() : undefined, existing && !existing.deleted ? existing : null)
    return row
  })

  app.delete('/api/documents/:id/markups/:markupId', { preHandler: auth }, async (req, reply) => {
    const doc = await documentWithAccess(req, reply, 'markup.delete')
    if (!doc) return
    const { markupId } = req.params as any
    const gone = await db.query(
      `UPDATE markups SET deleted = true, version = version + 1, struct_version = version + 1, updated_by = $1, updated_at = now()
       WHERE id = $2 AND document_id = $3 AND NOT deleted RETURNING id`, [req.user.id, markupId, doc.id])
    if (gone.length) {
      await recordEvent(markupId, req.user.id, 'deleted')
      realtime.markupDeleted(doc.id, markupId, req.user.id, cid(req))
    }
    return { ok: true }
  })

  // ---- Photo attachments (belong to markups) ----
  const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  const EXT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
  const PHOTO_MAX = 15 * 1024 * 1024
  /** Photos obey the smaller of their own cap and the organization's upload limit. */
  const photoMax = () => Math.min(PHOTO_MAX, runtime.maxUploadBytes)
  const ATT_COLUMNS = 'id, markup_id, caption, width, height, created_at, created_by, (annotated_key IS NOT NULL) AS has_annotation'

  /** Deletes a stored file only when nothing else (a revision, a frozen snapshot, a photo, a setting) still points at it. */
  async function releaseFiles(keys: (string | null | undefined)[]) {
    for (const key of new Set(keys.filter(Boolean) as string[])) {
      try {
        const ref = await db.query(
          `SELECT 1 AS x FROM document_revisions WHERE file_key = $1::text OR position($1::text in coalesce(attachments_snapshot::text, '')) > 0
           UNION ALL SELECT 1 FROM attachments WHERE file_key = $1::text OR annotated_key = $1::text
           UNION ALL SELECT 1 FROM settings WHERE position($1::text in value::text) > 0
           UNION ALL SELECT 1 FROM projects WHERE position($1::text in settings::text) > 0 LIMIT 1`, [key])
        if (!ref.length) await storage.remove(key)
      } catch { /* best effort */ }
    }
  }
  const removeFile = (key: string | null | undefined) => { void releaseFiles([key]) }
  const optInt = (v: unknown) => {
    const n = Number(v)
    return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 && n < 100000 ? n : null
  }

  async function markupWithAccess(req: FastifyRequest, reply: FastifyReply, cap: Cap) {
    const { markupId } = req.params as any
    if (!UUID_RE.test(String(markupId))) { reply.code(404).send({ error: 'Not found' }); return null }
    const [m] = await db.query(
      'SELECT m.*, d.project_id FROM markups m JOIN documents d ON d.id = m.document_id WHERE m.id = $1', [markupId])
    if (!m || m.deleted) { reply.code(404).send({ error: 'Not found' }); return null }
    const access = await requireCap(req, reply, m.project_id, cap)
    if (!access) return null
    if (!canSeeMarkup(access, m)) { reply.code(404).send({ error: 'Not found' }); return null }
    return m
  }

  async function attachmentWithAccess(req: FastifyRequest, reply: FastifyReply, cap: Cap) {
    const { id } = req.params as any
    if (!UUID_RE.test(String(id))) { reply.code(404).send({ error: 'Not found' }); return null }
    const [a] = await db.query(
      `SELECT a.*, d.project_id, m.symbol_set_id, m.layer_id FROM attachments a
       JOIN markups m ON m.id = a.markup_id JOIN documents d ON d.id = m.document_id WHERE a.id = $1`, [id])
    if (!a) { reply.code(404).send({ error: 'Not found' }); return null }
    const access = await requireCap(req, reply, a.project_id, cap)
    if (!access) return null
    if (!canSeeMarkup(access, a)) { reply.code(404).send({ error: 'Not found' }); return null }
    return a
  }

  /** Writes an uploaded photo to disk. Returns the key, or sends an error and returns null. */
  async function savePhoto(file: any, reply: FastifyReply) {
    if (!PHOTO_TYPES[file.mimetype]) { file.file.resume(); reply.code(400).send({ error: 'Only JPEG, PNG or WebP photos are supported' }); return null }
    const bytes = new Uint8Array(await file.toBuffer())
    if (file.file.truncated) { reply.code(413).send({ error: `Photo too large (${Math.round(photoMax() / 1048576)} MB max)` }); return null }
    const ext = photoExt(bytes) // what the bytes really are, not what the client said
    if (!ext) { reply.code(400).send({ error: 'That is not a valid JPEG, PNG or WebP image' }); return null }
    return storage.save(ext, bytes)
  }

  async function attachmentsChanged(a: { markup_id: string }, req: FastifyRequest) {
    const [m] = await db.query('SELECT document_id FROM markups WHERE id = $1', [a.markup_id])
    if (m) realtime.attachmentsChanged(m.document_id, a.markup_id, req.user.id, cid(req))
  }

  const attRow = async (id: string) => (await db.query(`SELECT ${ATT_COLUMNS} FROM attachments WHERE id = $1`, [id]))[0]

  app.get('/api/markups/:markupId/attachments', { preHandler: auth }, async (req, reply) => {
    const m = await markupWithAccess(req, reply, 'view')
    if (!m) return
    return db.query(`SELECT ${ATT_COLUMNS} FROM attachments WHERE markup_id = $1 ORDER BY created_at, id`, [m.id])
  })

  // Text fields (id, caption, width, height) must come before the `photo` file part.
  app.post('/api/markups/:markupId/attachments', { preHandler: auth }, async (req, reply) => {
    const m = await markupWithAccess(req, reply, 'photos.edit')
    if (!m) return
    const file = await req.file({ limits: { fileSize: photoMax() } })
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
    await recordEvent(m.id, req.user.id, 'photo_added', { attachment_id: id, caption: String(f.caption?.value ?? '') })
    realtime.attachmentsChanged(m.document_id, m.id, req.user.id, cid(req))
    return attRow(id)
  })

  app.patch('/api/attachments/:id', { preHandler: auth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'photos.edit')
    if (!a) return
    const caption = (req.body as any)?.caption
    if (typeof caption !== 'string') return reply.code(400).send({ error: 'caption is required' })
    await db.query('UPDATE attachments SET caption = $1 WHERE id = $2', [caption, a.id])
    await attachmentsChanged(a, req)
    return attRow(a.id)
  })

  app.put('/api/attachments/:id/annotated', { preHandler: auth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'photos.edit')
    if (!a) return
    const file = await req.file({ limits: { fileSize: photoMax() } })
    if (!file || file.fieldname !== 'photo') return reply.code(400).send({ error: 'No photo' })
    const key = await savePhoto(file, reply)
    if (!key) return
    await db.query('UPDATE attachments SET annotated_key = $1 WHERE id = $2', [key, a.id])
    removeFile(a.annotated_key)
    await recordEvent(a.markup_id, req.user.id, 'photo_annotated', { attachment_id: a.id, caption: a.caption })
    await attachmentsChanged(a, req)
    return attRow(a.id)
  })

  app.delete('/api/attachments/:id', { preHandler: auth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'photos.edit')
    if (!a) return
    await db.query('DELETE FROM attachments WHERE id = $1', [a.id])
    await recordEvent(a.markup_id, req.user.id, 'photo_deleted', { attachment_id: a.id, caption: a.caption })
    removeFile(a.file_key)
    removeFile(a.annotated_key)
    await attachmentsChanged(a, req)
    return { ok: true }
  })

  app.get('/api/attachments/:id/file', { preHandler: fileAuth }, async (req, reply) => {
    const a = await attachmentWithAccess(req, reply, 'view')
    if (!a) return
    const variant = (req.query as any)?.variant
    const key = variant === 'original' ? a.file_key : variant === 'annotated' ? a.annotated_key : (a.annotated_key ?? a.file_key)
    if (!key) return reply.code(404).send({ error: 'No such variant' })
    const stream = await storage.open(key)
    if (!stream) return reply.code(404).send({ error: 'File missing' })
    const ext = key.slice(key.lastIndexOf('.') + 1)
    fileHeaders(reply, EXT_TYPES[ext] ?? 'application/octet-stream', `photo-${a.id}.${ext}`)
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    return reply.send(stream)
  })

  // ---- Profile picture (own row; anyone signed in can fetch anyone's, it is shown next to their name) ----
  app.post('/api/me/avatar', { preHandler: auth }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: 5 * 1024 * 1024 } })
    if (!file || file.fieldname !== 'photo') return reply.code(400).send({ error: 'No picture' })
    const key = await savePhoto(file, reply)
    if (!key) return
    const [old] = await db.query('SELECT avatar_key FROM users WHERE id = $1', [req.user.id])
    const [row] = await db.query('UPDATE users SET avatar_key = $1, avatar_version = avatar_version + 1 WHERE id = $2 RETURNING avatar_version', [key, req.user.id])
    if (old?.avatar_key) void storage.remove(old.avatar_key)
    return { avatar: row.avatar_version }
  })

  app.delete('/api/me/avatar', { preHandler: auth }, async (req) => {
    const [old] = await db.query('SELECT avatar_key FROM users WHERE id = $1', [req.user.id])
    await db.query('UPDATE users SET avatar_key = NULL, avatar_version = avatar_version + 1 WHERE id = $1', [req.user.id])
    if (old?.avatar_key) void storage.remove(old.avatar_key)
    return { avatar: null }
  })

  app.get('/api/users/:id/avatar', { preHandler: fileAuth }, async (req, reply) => {
    const { id } = req.params as any
    const [u] = await db.query('SELECT avatar_key FROM users WHERE id = $1', [id])
    if (!u?.avatar_key) return reply.code(404).send({ error: 'No picture' })
    const stream = await storage.open(u.avatar_key)
    if (!stream) return reply.code(404).send({ error: 'File missing' })
    const ext = u.avatar_key.slice(u.avatar_key.lastIndexOf('.') + 1)
    fileHeaders(reply, EXT_TYPES[ext] ?? 'application/octet-stream', `avatar-${id}.${ext}`)
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    return reply.send(stream)
  })

  await registerProjectSettings({ app, db, auth, fileAuth, storage, requireCap, releaseFile: removeFile })
  await registerAdmin({ app, db, auth, fileAuth, storage, forgetUser, requireCap, sign, realtime, rl, keepsAnAdmin, dropFromProject, refreshAccess, publicUser, publicUrl, inviteRateLimitMax: INVITE_RL_MAX, reloadRuntime })
  await registerBackups({ app, db, auth })

  // ---- Built web app (production) ----
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir })
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'))
  }

  return app
}
