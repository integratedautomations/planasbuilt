export interface CompanySettings {
  name: string; address: string; phone: string; prepared_by: string; pdf_author_mode?: 'plan' | 'placer' | 'exporter' | 'custom'; pdf_author_text?: string; has_logo: boolean; logo_type: string
}
export interface S3Settings {
  endpoint: string; bucket: string; region: string; accessKeyId: string; pathStyle: boolean; prefix: string
  secret_set: boolean
  /** Write-only: only present while the admin is typing a new one. */
  secret?: string
}
export interface SmtpSettings {
  host: string; port: number; secure: boolean; user: string; from: string; pass_set: boolean; pass?: string
}
export interface AdminSettings {
  company: CompanySettings
  tags: { padding: 2 | 3 | 4 }
  photos: { max_dimension: number }
  retention: { mode: 'all' | 'keep'; keep_latest: number; /** Days removed files wait in the _trash folder (0 = delete at once). */ trash_days: number }
  storage: { backend: 'local' | 's3'; s3: S3Settings }
  smtp: SmtpSettings
  /** Sign-in rules. lockout_limit 0 = the built-in default. */
  security: { session_days: number; lockout_limit: number; lockout_base_min: number; lockout_cap_min: number }
  uploads: { max_upload_mb: number }
  invite: { sender_name: string; subject: string; body: string }
  /** Rules copied into new projects (see projectSettings.ts). */
  project_defaults: unknown
}
export interface Usage {
  db_bytes: number | null
  files: { total_bytes: number; local_bytes: number; s3_bytes: number; categories: { id: string; label: string; bytes: number }[] }
  projects: { id: string; name: string; plans_bytes: number; photos_bytes: number; total_bytes: number; file_count: number }[]
}
export interface CleanupPreview {
  mode: 'all' | 'keep'; keep_latest: number; reclaim_bytes: number
  candidates: { id: string; project: string; document: string; revision: number; label: string; created_at: string; bytes: number; file_kept: boolean }[]
}

export function formatBytes(n: number | null | undefined) {
  if (n === null || n === undefined) return 'n/a'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`
}
