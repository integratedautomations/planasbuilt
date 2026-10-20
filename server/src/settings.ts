// Organization settings: one row per section in the settings(key, value jsonb) table.
import type { Db } from './db.js'
import type { S3Config, StorageConfig } from './storage.js'
import type { SmtpConfig } from './mail.js'

export interface CompanySettings { name: string; address: string; phone: string; prepared_by: string; logo_key: string; logo_type: string }
export interface TagSettings { padding: 2 | 3 | 4 }
export interface PhotoSettings { max_dimension: number }
export interface RetentionSettings { mode: 'all' | 'keep'; keep_latest: number }
export interface StorageSettings { backend: 'local' | 's3'; s3: S3Config }

export const DEFAULTS = {
  company: { name: '', address: '', phone: '', prepared_by: '', logo_key: '', logo_type: '' } as CompanySettings,
  tags: { padding: 2 } as TagSettings,
  photos: { max_dimension: 2000 } as PhotoSettings,
  retention: { mode: 'all', keep_latest: 5 } as RetentionSettings,
  storage: {
    backend: 'local',
    s3: { endpoint: '', bucket: '', region: 'auto', accessKeyId: '', secret: '', pathStyle: false, prefix: '' },
  } as StorageSettings,
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' } as SmtpConfig,
}
export type SectionName = keyof typeof DEFAULTS

export async function getSection<K extends SectionName>(db: Db, key: K): Promise<(typeof DEFAULTS)[K]> {
  const [row] = await db.query('SELECT value FROM settings WHERE key = $1', [key])
  const v = row?.value && typeof row.value === 'object' ? row.value : {}
  const d = DEFAULTS[key] as any
  const out = { ...d, ...v }
  if (key === 'storage') out.s3 = { ...d.s3, ...(v.s3 ?? {}) }
  return out
}

export async function putSection(db: Db, key: SectionName, value: unknown) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)])
}

const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max)
const int = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

/** Validates a partial update for a section against what is stored. Returns the new value or an error message. */
export function mergeSection(key: SectionName, current: any, patch: any): { value: any } | { error: string } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: `${key} must be an object` }
  switch (key) {
    case 'company': {
      const c = { ...current }
      for (const k of ['name', 'phone', 'prepared_by'] as const) if (k in patch) c[k] = str(patch[k], 200)
      if ('address' in patch) c.address = str(patch.address, 1000)
      return { value: c }
    }
    case 'tags': {
      const p = Number(patch.padding)
      if (![2, 3, 4].includes(p)) return { error: 'Tag number padding must be 2, 3 or 4 digits' }
      return { value: { padding: p } }
    }
    case 'photos':
      return { value: { max_dimension: int(patch.max_dimension, 800, 6000, current.max_dimension) } }
    case 'retention': {
      const mode = patch.mode === 'keep' ? 'keep' : patch.mode === 'all' ? 'all' : current.mode
      return { value: { mode, keep_latest: int(patch.keep_latest, 1, 100, current.keep_latest) } }
    }
    case 'storage': {
      const backend = patch.backend === 's3' ? 's3' : patch.backend === 'local' ? 'local' : current.backend
      const s = { ...current.s3 }
      const p = patch.s3 && typeof patch.s3 === 'object' ? patch.s3 : {}
      for (const k of ['endpoint', 'bucket', 'region', 'accessKeyId', 'prefix'] as const) if (k in p) s[k] = str(p[k], 300)
      if ('pathStyle' in p) s.pathStyle = !!p.pathStyle
      // The secret is write-only: blank or the mask means "keep what is stored".
      if (typeof p.secret === 'string' && p.secret.trim() && !/^•+$/.test(p.secret)) s.secret = p.secret.trim()
      return { value: { backend, s3: s } }
    }
    case 'smtp': {
      const s = { ...current }
      for (const k of ['host', 'user', 'from'] as const) if (k in patch) s[k] = str(patch[k], 300)
      if ('port' in patch) s.port = int(patch.port, 0, 65535, current.port)
      if ('secure' in patch) s.secure = !!patch.secure
      if (typeof patch.pass === 'string' && patch.pass.trim() && !/^•+$/.test(patch.pass)) s.pass = patch.pass.trim()
      return { value: s }
    }
  }
}

/** What an admin sees: everything, with write-only secrets replaced by a "set" flag. */
export function maskSection(key: SectionName, v: any) {
  if (key === 'storage') {
    const { secret, ...s3 } = v.s3
    return { backend: v.backend, s3: { ...s3, secret_set: !!secret } }
  }
  if (key === 'smtp') {
    const { pass, ...rest } = v
    return { ...rest, pass_set: !!pass }
  }
  return v
}

export const storageConfigOf = (s: StorageSettings): StorageConfig => ({ backend: s.backend, s3: s.backend === 's3' ? s.s3 : null })
