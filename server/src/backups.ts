// Off-site backups: admin API + rclone config generation.
// Settings live in the settings table under key 'backups' (secrets AES-256-GCM encrypted with BACKUP_ENCRYPTION_KEY).
// The server writes rclone.conf + targets.json into a directory shared with the `backup` service (RCLONE_DIR);
// deploy/backup.sh uploads after each local backup, applies remote retention and writes status.json there.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from './db.js'

// ---------- rclone "obscure" ----------
// rclone stores passwords in its config as base64url(iv || AES-256-CTR(plaintext)) with a fixed, public key.
// It is obfuscation, not security: the real protection is the mode-600 config file in a private volume.
const OBSCURE_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb, 0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
])

export function obscure(plain: string, iv: Buffer = randomBytes(16)): string {
  const c = createCipheriv('aes-256-ctr', OBSCURE_KEY, iv)
  return Buffer.concat([iv, c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64url')
}
export function reveal(obscured: string): string {
  const raw = Buffer.from(obscured, 'base64url')
  if (raw.length < 16) throw new Error('input too short when revealing password')
  const c = createDecipheriv('aes-256-ctr', OBSCURE_KEY, raw.subarray(0, 16))
  return Buffer.concat([c.update(raw.subarray(16)), c.final()]).toString('utf8')
}

// ---------- secrets at rest ----------
export class NoEncryptionKey extends Error {
  constructor() { super('BACKUP_ENCRYPTION_KEY is not set on the server, so backup passwords and tokens cannot be stored. Generate one with "openssl rand -hex 32", add it to .env as BACKUP_ENCRYPTION_KEY and recreate the app container.') }
}
const keyOf = (env: NodeJS.ProcessEnv) => {
  const k = env.BACKUP_ENCRYPTION_KEY?.trim()
  if (!k || k.length < 16) throw new NoEncryptionKey()
  return createHash('sha256').update(k, 'utf8').digest()
}
export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyOf(env), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.')
}
export function decryptSecret(blob: string, env: NodeJS.ProcessEnv = process.env): string {
  const [v, iv, tag, ct] = blob.split('.')
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unreadable stored secret')
  const d = createDecipheriv('aes-256-gcm', keyOf(env), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  try { return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8') }
  catch { throw new Error('Stored backup secrets cannot be decrypted: BACKUP_ENCRYPTION_KEY changed. Re-enter the passwords and tokens.') }
}

// ---------- model ----------
export type TargetType = 'sftp' | 's3' | 'onedrive' | 'drive' | 'zoho'
export interface Target {
  id: string
  name: string
  type: TargetType
  enabled: boolean
  /** Folder on the remote (S3: prefix inside the bucket). */
  path: string
  retention_days: number
  config: Record<string, string>
  /** Encrypted secret values by field name. */
  secrets: Record<string, string>
  crypt: { enabled: boolean; password: string }
}

interface FieldSpec { key: string; required?: boolean; default?: string }
interface TypeSpec { label: string; config: FieldSpec[]; secrets: FieldSpec[]; oauth?: string }
export const SPECS: Record<TargetType, TypeSpec> = {
  sftp: { label: 'SFTP', config: [{ key: 'host', required: true }, { key: 'port', default: '22' }, { key: 'user', required: true }], secrets: [{ key: 'pass' }, { key: 'key_pem' }] },
  s3: { label: 'S3-compatible', config: [{ key: 'provider', default: 'Other' }, { key: 'endpoint' }, { key: 'region' }, { key: 'access_key_id', required: true }, { key: 'bucket', required: true }], secrets: [{ key: 'secret_access_key', required: true }] },
  onedrive: { label: 'OneDrive', oauth: 'onedrive', config: [{ key: 'drive_type' }, { key: 'drive_id' }, { key: 'client_id' }], secrets: [{ key: 'token', required: true }, { key: 'client_secret' }] },
  drive: { label: 'Google Drive', oauth: 'drive', config: [{ key: 'root_folder_id' }, { key: 'client_id' }], secrets: [{ key: 'token', required: true }, { key: 'client_secret' }] },
  zoho: { label: 'Zoho WorkDrive', oauth: 'zoho', config: [{ key: 'region', default: 'com' }, { key: 'client_id' }], secrets: [{ key: 'token', required: true }, { key: 'client_secret' }] },
}
const TYPES = Object.keys(SPECS) as TargetType[]
const S3_PROVIDERS = ['AWS', 'Cloudflare', 'Minio', 'Wasabi', 'Backblaze', 'DigitalOcean', 'Other']
const ID_RE = /^[a-f0-9]{8}$/
export const section = (t: { id: string }) => `t${t.id}`

const clean = (v: unknown, max = 500) => String(v ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max)

/** Accepts the bare token JSON or the whole `rclone authorize` output; returns the one-line JSON. */
export function parseToken(input: string): string | null {
  const s = input.trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b < a) return null
  try {
    const j = JSON.parse(s.slice(a, b + 1))
    if (!j || typeof j !== 'object' || (!j.access_token && !j.refresh_token)) return null
    return JSON.stringify(j)
  } catch { return null }
}

export function cleanPath(p: unknown, type: TargetType): string | null {
  let s = clean(p, 300).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (type !== 'sftp') s = s.replace(/^\/+/, '')
  s = s.replace(/\/+$/, '')
  if (s.split('/').some(seg => seg === '..' || seg === '.')) return null
  return s
}

// ---------- config generation ----------
const iniVal = (v: string) => v.replace(/\r?\n/g, '\\n')

/** rclone.conf text + the secret-free targets.json that backup.sh reads. `dec` decrypts a stored secret. */
export function buildConfig(targets: Target[], dec: (blob: string) => string): { conf: string; targets: any[] } {
  const out: string[] = []
  const list: any[] = []
  for (const t of targets) {
    const sec = (k: string) => (t.secrets[k] ? dec(t.secrets[k]) : '')
    const name = section(t)
    const lines: string[] = [`[${name}]`]
    const put = (k: string, v: string | undefined) => { if (v) lines.push(`${k} = ${iniVal(v)}`) }
    const c = t.config
    let remotePath = t.path
    switch (t.type) {
      case 'sftp':
        put('type', 'sftp'); put('host', c.host); put('port', c.port || '22'); put('user', c.user)
        if (sec('pass')) put('pass', obscure(sec('pass')))
        if (sec('key_pem')) put('key_pem', sec('key_pem').trim())
        put('set_modtime', 'false')
        break
      case 's3':
        put('type', 's3'); put('provider', c.provider || 'Other'); put('env_auth', 'false')
        put('access_key_id', c.access_key_id); put('secret_access_key', sec('secret_access_key'))
        put('endpoint', c.endpoint); put('region', c.region)
        if ((c.provider || 'Other') === 'Other' || c.provider === 'Minio') put('force_path_style', 'true')
        remotePath = [c.bucket, t.path].filter(Boolean).join('/')
        break
      case 'onedrive':
        put('type', 'onedrive'); put('token', sec('token')); put('drive_type', c.drive_type); put('drive_id', c.drive_id)
        put('client_id', c.client_id); put('client_secret', sec('client_secret'))
        break
      case 'drive':
        put('type', 'drive'); put('scope', 'drive'); put('token', sec('token')); put('root_folder_id', c.root_folder_id)
        put('client_id', c.client_id); put('client_secret', sec('client_secret'))
        break
      case 'zoho':
        put('type', 'zoho'); put('token', sec('token')); put('region', c.region || 'com')
        put('client_id', c.client_id); put('client_secret', sec('client_secret'))
        break
    }
    out.push(lines.join('\n'))
    let remote = `${name}:${remotePath}`
    if (t.crypt.enabled && t.crypt.password) {
      const cname = `${name}c`
      out.push([`[${cname}]`, 'type = crypt', `remote = ${remote}`, 'filename_encryption = standard', 'directory_name_encryption = true', `password = ${obscure(dec(t.crypt.password))}`].join('\n'))
      remote = `${cname}:`
    }
    list.push({ id: t.id, name: t.name, type: t.type, enabled: t.enabled, remote, retention_days: t.retention_days })
  }
  return { conf: out.join('\n\n') + (out.length ? '\n' : ''), targets: list }
}

// ---------- API ----------
type Auth = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
type RcloneRun = (args: string[]) => Promise<{ ok: boolean; output: string }>

export interface BackupsContext {
  app: FastifyInstance
  db: Db
  auth: Auth
  /** Shared config directory (default $RCLONE_DIR or /backups/.rclone). */
  dir?: string
  env?: NodeJS.ProcessEnv
  /** Runs rclone (tests inject a fake). */
  rclone?: RcloneRun
  /** Looks up OneDrive drive id/type from a token JSON (tests inject a fake). */
  resolveOneDrive?: (token: string) => Promise<{ drive_id: string; drive_type: string } | null>
}

const realRclone: RcloneRun = args => new Promise(resolve => {
  execFile('rclone', args, { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const output = `${stdout}${stderr}`.trim().slice(-800)
    if (err) return resolve({ ok: false, output: output || (err as Error).message })
    resolve({ ok: true, output })
  })
})

async function realResolveOneDrive(token: string) {
  try {
    const at = JSON.parse(token).access_token
    if (!at) return null
    const r = await fetch('https://graph.microsoft.com/v1.0/me/drive', { headers: { Authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    const j: any = await r.json()
    return j?.id ? { drive_id: String(j.id), drive_type: String(j.driveType || 'personal') } : null
  } catch { return null }
}

export async function registerBackups(ctx: BackupsContext) {
  const { app, db, auth } = ctx
  const env = ctx.env ?? process.env
  const dir = ctx.dir ?? env.RCLONE_DIR ?? '/backups/.rclone'
  const rclone = ctx.rclone ?? realRclone
  const resolveOneDrive = ctx.resolveOneDrive ?? realResolveOneDrive
  const confPath = path.join(dir, 'rclone.conf')

  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user.isAdmin) { reply.code(403).send({ error: 'Admins only' }); return false }
    return true
  }
  const hasKey = () => { try { keyOf(env); return true } catch { return false } }

  async function load(): Promise<Target[]> {
    const [row] = await db.query('SELECT value FROM settings WHERE key = $1', ['backups'])
    return Array.isArray(row?.value?.targets) ? row.value.targets : []
  }
  async function store(targets: Target[]) {
    await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['backups', JSON.stringify({ targets })])
  }
  /** Writes rclone.conf (mode 600) and targets.json. Returns an error message instead of throwing. */
  function writeFiles(targets: Target[]): string | null {
    try {
      const { conf, targets: list } = buildConfig(targets, b => decryptSecret(b, env))
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      const put = (file: string, data: string, mode: number) => {
        const p = path.join(dir, file), tmp = `${p}.${process.pid}.tmp`
        writeFileSync(tmp, data, { mode }); chmodSync(tmp, mode); renameSync(tmp, p)
      }
      put('rclone.conf', conf, 0o600)
      put('targets.json', JSON.stringify(list, null, 2), 0o644)
      return null
    } catch (e) { return (e as Error).message }
  }
  function readStatus(): any[] {
    try {
      const j = JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8'))
      return Array.isArray(j) ? j : []
    } catch { return [] }
  }

  const view = (t: Target) => ({
    id: t.id, name: t.name, type: t.type, enabled: t.enabled, path: t.path, retention_days: t.retention_days,
    config: t.config,
    has_secret: Object.fromEntries(SPECS[t.type].secrets.map(s => [s.key, !!t.secrets[s.key]])),
    crypt: { enabled: t.crypt.enabled, has_password: !!t.crypt.password },
  })
  const statusView = (targets: Target[]) => {
    const st = readStatus()
    return targets.map(t => {
      const s = st.find(x => x.target === t.id)
      return { target: t.id, name: t.name, enabled: t.enabled, ok: s ? !!s.ok : null, at: s?.at ?? null, error: s?.error ?? '', bytes: s?.bytes ?? null }
    })
  }

  /** Validates a body against a stored target (or none) and returns the merged target. */
  async function merge(body: any, cur: Target | null): Promise<{ t: Target } | { error: string }> {
    if (!body || typeof body !== 'object') return { error: 'Invalid request' }
    const type: TargetType = cur ? cur.type : body.type
    if (!TYPES.includes(type)) return { error: 'Unknown target type' }
    const spec = SPECS[type]
    const t: Target = cur ? structuredClone(cur) : {
      id: randomBytes(4).toString('hex'), name: '', type, enabled: true, path: '', retention_days: 30,
      config: {}, secrets: {}, crypt: { enabled: false, password: '' },
    }
    if ('name' in body || !cur) t.name = clean(body.name, 80)
    if (!t.name) return { error: 'Give the target a name' }
    if ('enabled' in body) t.enabled = !!body.enabled
    if ('path' in body || !cur) {
      const p = cleanPath(body.path, type)
      if (p === null) return { error: 'The remote folder cannot contain "." or ".." segments' }
      t.path = p
    }
    if ('retention_days' in body) {
      const n = Math.round(Number(body.retention_days))
      if (!Number.isFinite(n) || n < 0 || n > 3650) return { error: 'Remote retention must be 0 (keep forever) to 3650 days' }
      t.retention_days = n
    }
    const cfg = body.config && typeof body.config === 'object' ? body.config : {}
    for (const f of spec.config) {
      if (f.key in cfg || !cur) t.config[f.key] = clean(cfg[f.key], 500) || f.default || ''
      if (f.required && !t.config[f.key]) return { error: `${f.key} is required` }
    }
    if (type === 'sftp' && !/^\d{1,5}$/.test(t.config.port)) return { error: 'Port must be a number' }
    if (type === 's3' && !S3_PROVIDERS.includes(t.config.provider)) return { error: 'Unknown S3 provider' }
    // Secrets are write-only: blank means "keep what is stored".
    const sec = body.secrets && typeof body.secrets === 'object' ? body.secrets : {}
    const incoming: Array<[string, string]> = []
    for (const f of spec.secrets) {
      let v = typeof sec[f.key] === 'string' ? sec[f.key].trim() : ''
      if (!v || /^•+$/.test(v)) continue
      if (f.key === 'token') {
        const tok = parseToken(v)
        if (!tok) return { error: `That is not a valid token. Paste the JSON printed by: rclone authorize "${spec.oauth}"` }
        v = tok
      }
      if (f.key === 'key_pem') {
        if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) return { error: 'The SSH key must be a PEM private key (-----BEGIN ... PRIVATE KEY-----)' }
        v = v.replace(/\r?\n/g, '\\n') // rclone wants the key on one line with literal \n
      }
      incoming.push([f.key, v])
    }
    const crypt = body.crypt && typeof body.crypt === 'object' ? body.crypt : null
    const cryptPw = crypt && typeof crypt.password === 'string' && crypt.password && !/^•+$/.test(crypt.password) ? crypt.password : ''
    if (crypt && 'enabled' in crypt) t.crypt.enabled = !!crypt.enabled
    if (incoming.length || cryptPw) {
      try {
        for (const [k, v] of incoming) t.secrets[k] = encryptSecret(v, env)
        if (cryptPw) t.crypt.password = encryptSecret(cryptPw, env)
      } catch (e) { return { error: (e as Error).message } }
    }
    if (t.crypt.enabled && !t.crypt.password) return { error: 'Enter a passphrase for the encryption wrapper' }
    for (const f of spec.secrets) if (f.required && !t.secrets[f.key]) return { error: f.key === 'token' ? `Paste the token from: rclone authorize "${spec.oauth}"` : `${f.key} is required` }
    if (type === 'sftp' && !t.secrets.pass && !t.secrets.key_pem) return { error: 'Enter a password or an SSH private key' }
    if (type === 'onedrive' && incoming.some(([k]) => k === 'token') && !(t.config.drive_id && t.config.drive_type)) {
      const found = await resolveOneDrive(decryptSecret(t.secrets.token, env))
      if (found) { t.config.drive_id = found.drive_id; t.config.drive_type = found.drive_type }
      else return { error: 'Could not look up your OneDrive drive. The token may be too old: run the authorize command again and paste the fresh token right away, or fill in Drive ID and Drive type (shown by "rclone config" on your PC).' }
    }
    return { t }
  }

  const guard = { preHandler: auth }

  app.get('/api/admin/backups', guard, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return
    const targets = await load()
    return {
      encryption_ready: hasKey(),
      types: Object.fromEntries(TYPES.map(k => [k, { label: SPECS[k].label, oauth: SPECS[k].oauth ?? null }])),
      targets: targets.map(view),
      status: statusView(targets),
      run_pending: existsSync(path.join(dir, 'run-now')),
    }
  })

  app.get('/api/admin/backups/status', guard, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return
    const status = statusView(await load())
    return { status, failed: status.filter(s => s.enabled && s.ok === false) }
  })

  const save = async (req: FastifyRequest, reply: FastifyReply, id: string | null) => {
    if (!(await adminOnly(req, reply))) return
    const targets = await load()
    const cur = id ? targets.find(t => t.id === id) ?? null : null
    if (id && !cur) return reply.code(404).send({ error: 'Target not found' })
    const r = await merge(req.body, cur)
    if ('error' in r) return reply.code(400).send({ error: r.error })
    const next = cur ? targets.map(t => (t.id === cur.id ? r.t : t)) : [...targets, r.t]
    await store(next)
    const warning = writeFiles(next)
    return reply.code(cur ? 200 : 201).send({ ...view(r.t), warning })
  }
  app.post('/api/admin/backups/targets', guard, (req, reply) => save(req, reply, null))
  app.put('/api/admin/backups/targets/:id', guard, (req, reply) => save(req, reply, (req.params as any).id))

  app.delete('/api/admin/backups/targets/:id', guard, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return
    const id = (req.params as any).id
    const targets = await load()
    if (!targets.some(t => t.id === id)) return reply.code(404).send({ error: 'Target not found' })
    const next = targets.filter(t => t.id !== id)
    await store(next)
    return { ok: true, warning: writeFiles(next) }
  })

  app.post('/api/admin/backups/targets/:id/test', guard, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return
    const id = (req.params as any).id
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'Target not found' })
    const targets = await load()
    const t = targets.find(x => x.id === id)
    if (!t) return reply.code(404).send({ error: 'Target not found' })
    const warn = writeFiles(targets)
    if (warn) return reply.code(500).send({ ok: false, error: `Could not write the rclone config: ${warn}` })
    const remote = buildConfig([t], b => decryptSecret(b, env)).targets[0].remote
    const base = ['--config', confPath, '--contimeout', '15s', '--timeout', '30s', '--retries', '1', '--low-level-retries', '2']
    const mk = await rclone([...base, 'mkdir', remote])
    if (!mk.ok) return { ok: false, error: mk.output || 'Connection failed' }
    const ls = await rclone([...base, 'lsd', remote])
    return ls.ok ? { ok: true } : { ok: false, error: ls.output || 'Connection failed' }
  })

  app.post('/api/admin/backups/run-now', guard, async (req, reply) => {
    if (!(await adminOnly(req, reply))) return
    const targets = await load()
    if (!targets.some(t => t.enabled)) return reply.code(400).send({ error: 'Enable at least one target first' })
    const warn = writeFiles(targets)
    if (warn) return reply.code(500).send({ error: `Could not write the rclone config: ${warn}` })
    try { writeFileSync(path.join(dir, 'run-now'), new Date().toISOString(), { mode: 0o644 }) }
    catch (e) { return reply.code(500).send({ error: `Could not request a backup: ${(e as Error).message}` }) }
    return { ok: true }
  })
}
