// Company settings: one row per section and company in the settings(company_id, key, value jsonb) table.
// A few values are install-wide instead and live in system_settings(key, value) (getSystem / putSystem).
import type { Db } from './db.js'
import type { S3Config, StorageConfig } from './storage.js'
import type { SmtpConfig } from './mail.js'
import { DEFAULT_PROJECT_SETTINGS, defaultsPart, mergeProjectSettings, readProjectSettings } from './projectSettings.js'

export interface CompanySettings { name: string; address: string; phone: string; prepared_by: string; logo_key: string; logo_type: string }
export interface TagSettings { padding: 2 | 3 | 4 }
export interface PhotoSettings { max_dimension: number }
export interface RetentionSettings { mode: 'all' | 'keep'; keep_latest: number }
export interface StorageSettings { backend: 'local' | 's3'; s3: S3Config }

/** Sign-in rules. lockout_limit 0 = the built-in default (10 failures). */
export interface SecuritySettings { session_days: number; lockout_limit: number; lockout_base_min: number; lockout_cap_min: number }
export interface UploadSettings { max_upload_mb: number }
/** Invite email text. Placeholders: {name} {inviter} {company} {link} {days}. */
export interface InviteSettings { sender_name: string; subject: string; body: string }
export const INVITE_PLACEHOLDERS = ['name', 'inviter', 'company', 'link', 'days'] as const
export const DEFAULT_INVITE: InviteSettings = {
  sender_name: '',
  subject: 'You are invited to {company}',
  body: '{inviter} invited you to {company} on PlanAsBuilt.\n\nSet your password here (valid for {days} days):\n{link}\n',
}

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
  security: { session_days: 30, lockout_limit: 0, lockout_base_min: 1, lockout_cap_min: 15 } as SecuritySettings,
  uploads: { max_upload_mb: 200 } as UploadSettings,
  invite: DEFAULT_INVITE as InviteSettings,
  /** Copied into every new project (a ProjectSettings without logo and lock). */
  project_defaults: defaultsPart(DEFAULT_PROJECT_SETTINGS) as any,
}
/** Fills an invite template's {placeholders}; unknown ones stay as typed. The subject is one line. */
export function renderInvite(t: InviteSettings, v: Record<string, string>) {
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m))
  return { subject: fill(t.subject).replace(/[\r\n]+/g, ' ').trim(), body: fill(t.body) }
}

export type SectionName = keyof typeof DEFAULTS

export async function getSection<K extends SectionName>(db: Pick<Db, 'query'>, companyId: string, key: K): Promise<(typeof DEFAULTS)[K]> {
  const [row] = await db.query('SELECT value FROM settings WHERE company_id = $1 AND key = $2', [companyId, key])
  const v = row?.value && typeof row.value === 'object' ? row.value : {}
  const d = DEFAULTS[key] as any
  const out = { ...d, ...v }
  if (key === 'storage') out.s3 = { ...d.s3, ...(v.s3 ?? {}) }
  return out
}

export async function putSection(db: Pick<Db, 'query'>, companyId: string, key: SectionName, value: unknown) {
  await db.query(
    `INSERT INTO settings (company_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [companyId, key, JSON.stringify(value)])
}

/** Install-wide values (not owned by any company) live in system_settings. */
export async function getSystem<T = any>(db: Pick<Db, 'query'>, key: string, fallback: T): Promise<T> {
  const [row] = await db.query('SELECT value FROM system_settings WHERE key = $1', [key])
  return row?.value ?? fallback
}

export async function putSystem(db: Pick<Db, 'query'>, key: string, value: unknown) {
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
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
    case 'security':
      return { value: {
        session_days: int(patch.session_days, 1, 365, current.session_days),
        lockout_limit: patch.lockout_limit === 0 ? 0 : int(patch.lockout_limit, 3, 100, current.lockout_limit),
        lockout_base_min: int(patch.lockout_base_min, 1, 60, current.lockout_base_min),
        lockout_cap_min: int(patch.lockout_cap_min, 1, 1440, current.lockout_cap_min),
      } }
    case 'uploads':
      return { value: { max_upload_mb: int(patch.max_upload_mb, 1, 1024, current.max_upload_mb) } }
    case 'invite': {
      const i = { ...current }
      if ('sender_name' in patch) i.sender_name = str(patch.sender_name, 100)
      if ('subject' in patch) i.subject = str(patch.subject, 200)
      if ('body' in patch) i.body = String(patch.body ?? '').replace(/\r\n/g, '\n').slice(0, 5000)
      if (!i.subject.trim()) return { error: 'The invite email needs a subject' }
      if (!i.body.includes('{link}')) return { error: 'The invite email body must include {link}, or the person cannot set a password' }
      const bad = [...(i.subject + i.body).matchAll(/\{(\w*)\}/g)].map(m => m[1]).filter(k => !(INVITE_PLACEHOLDERS as readonly string[]).includes(k))
      if (bad.length) return { error: `Unknown placeholder {${bad[0]}}. Use ${INVITE_PLACEHOLDERS.map(k => `{${k}}`).join(', ')}` }
      return { value: i }
    }
    case 'project_defaults': {
      const m = mergeProjectSettings(readProjectSettings(current), patch)
      return 'error' in m ? m : { value: defaultsPart(m.value) }
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
