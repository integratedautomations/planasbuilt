import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Brand } from '../Brand'
import { CompanySwitcher } from '../company/CompanySwitcher'
import { OfflineBanner } from '../offline/OfflineBanner'
import { UserMenu } from './UserMenu'
import './backups.css'

type TargetType = 'sftp' | 's3' | 'onedrive' | 'drive' | 'zoho'
interface BackupTarget {
  id: string; name: string; type: TargetType; enabled: boolean; path: string; retention_days: number
  config: Record<string, string>
  has_secret: Record<string, boolean>
  crypt: { enabled: boolean; has_password: boolean }
}
interface TargetStatus { target: string; name: string; enabled: boolean; ok: boolean | null; at: string | null; error: string; bytes: number | null }
interface Overview {
  encryption_ready: boolean
  types: Record<TargetType, { label: string; oauth: string | null }>
  targets: BackupTarget[]
  status: TargetStatus[]
  run_pending: boolean
}

const TYPE_ORDER: TargetType[] = ['sftp', 's3', 'onedrive', 'drive', 'zoho']
const S3_PROVIDERS = ['AWS', 'Cloudflare', 'Minio', 'Wasabi', 'Backblaze', 'DigitalOcean', 'Other']
const ZOHO_REGIONS = ['com', 'eu', 'in', 'com.au', 'jp', 'com.cn']

const formatBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never')

/** Banner for admins when the last off-site copy of any enabled target failed. Renders nothing otherwise. */
export function BackupAlert() {
  const [failed, setFailed] = useState<TargetStatus[]>([])
  useEffect(() => {
    let live = true
    const load = () => api<{ failed: TargetStatus[] }>('/admin/backups/status').then(r => { if (live) setFailed(r.failed) }).catch(() => {})
    void load()
    const t = setInterval(load, 5 * 60_000)
    return () => { live = false; clearInterval(t) }
  }, [])
  if (failed.length === 0) return null
  return (
    <div className="backup-alert" role="alert">
      Off-site backup failed for {failed.map(f => f.name).join(', ')}. <Link to="/backups">Check Backups</Link>
    </div>
  )
}

export function BackupsPage() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<BackupTarget | 'new' | null>(null)
  const [msg, setMsg] = useState('')

  const reload = useCallback(() => api<Overview>('/admin/backups').then(setData).catch(e => setError(e.message)), [])
  useEffect(() => { void reload() }, [reload])

  async function runNow() {
    setMsg(''); setError('')
    try {
      await api('/admin/backups/run-now', { method: 'POST' })
      setMsg('Backup requested. It starts within a few seconds; reload this page in a minute to see the result.')
      void reload()
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <CompanySwitcher />
        <span className="muted">/</span>
        <span className="crumb">Backups</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content content-wide backups-page">
        <div className="row wrap">
          <h2>Off-site backups</h2>
          <span className="spacer" />
          <button onClick={runNow} disabled={!data || !data.targets.some(t => t.enabled)}>Run backup now</button>
          <button className="primary" onClick={() => setEditing('new')} disabled={!data}>Add target</button>
        </div>
        <p className="muted small">
          Each night the backup service saves the database and files, then copies them to every enabled target below with rclone.
          Local copies are kept for BACKUP_RETENTION_DAYS; each target has its own retention.
        </p>
        {error && <div className="error">{error}</div>}
        {msg && <div className="muted small" role="status">{msg}</div>}
        {data && !data.encryption_ready && (
          <div className="error" role="alert">
            BACKUP_ENCRYPTION_KEY is not set on the server, so passwords and tokens cannot be saved. Run <code>openssl rand -hex 32</code>,
            put the result in <code>.env</code> as <code>BACKUP_ENCRYPTION_KEY=...</code>, and recreate the app container.
          </div>
        )}
        {!data ? <p className="muted">Loading…</p> : (
          <>
            {data.targets.length === 0 && <p className="muted">No targets yet. Add one to start copying backups off this server.</p>}
            {data.targets.map(t => (
              <TargetCard key={t.id} t={t} label={data.types[t.type]?.label ?? t.type} status={data.status.find(s => s.target === t.id)}
                onEdit={() => setEditing(t)} onChanged={reload} />
            ))}
          </>
        )}
      </main>
      {editing && data && (
        <TargetEditor target={editing === 'new' ? null : editing} types={data.types} encryptionReady={data.encryption_ready}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload() }} />
      )}
    </div>
  )
}

function TargetCard({ t, label, status, onEdit, onChanged }: {
  t: BackupTarget; label: string; status?: TargetStatus; onEdit: () => void; onChanged: () => void
}) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function test() {
    setTesting(true); setResult(null)
    try {
      const r = await api<{ ok: boolean; error?: string }>(`/admin/backups/targets/${t.id}/test`, { method: 'POST' })
      setResult(r.ok ? { ok: true, text: 'Connected.' } : { ok: false, text: r.error ?? 'Connection failed' })
    } catch (e) { setResult({ ok: false, text: (e as Error).message }) }
    finally { setTesting(false) }
  }
  async function toggle() {
    try { await api(`/admin/backups/targets/${t.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !t.enabled }) }); onChanged() }
    catch (e) { setResult({ ok: false, text: (e as Error).message }) }
  }
  async function remove() {
    if (!confirm(`Remove "${t.name}"? Backups already copied there are not deleted.`)) return
    try { await api(`/admin/backups/targets/${t.id}`, { method: 'DELETE' }); onChanged() }
    catch (e) { setResult({ ok: false, text: (e as Error).message }) }
  }

  const last = status?.ok == null
    ? <span className="muted">No run yet</span>
    : status.ok
      ? <span className="status-pill active">OK</span>
      : <span className="status-pill deactivated">Failed</span>

  return (
    <section className="card settings-card backup-target">
      <div className="row wrap">
        <h3>{t.name}</h3>
        <span className="muted small">{label}{t.crypt.enabled ? ', encrypted' : ''}</span>
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={t.enabled} onChange={toggle} /> Enabled</label>
      </div>
      <div className="muted small">
        Folder: {t.path || '(root)'} · Remote retention: {t.retention_days > 0 ? `${t.retention_days} days` : 'keep forever'}
      </div>
      <div className="row wrap small">
        <span>Last run: {last} {status?.at && <span className="muted">{when(status.at)}</span>}</span>
        {status?.ok && status.bytes != null && <span className="muted">{formatBytes(status.bytes)} stored</span>}
      </div>
      {status?.ok === false && <div className="error">{status.error || 'Unknown error'}</div>}
      {result && <div className={result.ok ? 'muted small' : 'error'} role="status">{result.text}</div>}
      <div className="row wrap">
        <button onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>
        <button onClick={onEdit}>Edit</button>
        <button onClick={remove}>Remove</button>
      </div>
    </section>
  )
}

function TargetEditor({ target, types, encryptionReady, onClose, onSaved }: {
  target: BackupTarget | null; types: Overview['types']; encryptionReady: boolean; onClose: () => void; onSaved: () => void
}) {
  const [type, setType] = useState<TargetType>(target?.type ?? 'sftp')
  const [name, setName] = useState(target?.name ?? '')
  const [path, setPath] = useState(target?.path ?? 'PlanAsBuilt-backups')
  const [days, setDays] = useState(String(target?.retention_days ?? 30))
  const [enabled, setEnabled] = useState(target?.enabled ?? true)
  const [config, setConfig] = useState<Record<string, string>>(target?.config ?? {})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [crypt, setCrypt] = useState(target?.crypt.enabled ?? false)
  const [cryptPw, setCryptPw] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const has = (k: string) => !!target?.has_secret[k]
  const cfg = (k: string, d = '') => config[k] ?? d
  const setCfg = (k: string, v: string) => setConfig(c => ({ ...c, [k]: v }))
  const setSec = (k: string, v: string) => setSecrets(s => ({ ...s, [k]: v }))
  const oauth = types[type]?.oauth
  const secretPlaceholder = (k: string) => (has(k) ? 'Saved. Leave blank to keep it.' : '')

  async function save() {
    setError(''); setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name, path, enabled, retention_days: Number(days), config, secrets,
        crypt: { enabled: crypt, password: cryptPw },
      }
      if (!target) body.type = type
      await api(target ? `/admin/backups/targets/${target.id}` : '/admin/backups/targets', { method: target ? 'PUT' : 'POST', body: JSON.stringify(body) })
      onSaved()
    } catch (e) { setError((e as Error).message) }
    finally { setSaving(false) }
  }

  const authCmd = oauth ? `rclone authorize "${oauth}"` : ''
  const customCmd = oauth ? `rclone authorize "${oauth}" "<client_id>" "<client_secret>"` : ''

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={target ? 'Edit backup target' : 'Add backup target'} onClick={e => e.stopPropagation()}>
        <div className="row"><h3>{target ? 'Edit target' : 'Add target'}</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        {!encryptionReady && <div className="error">BACKUP_ENCRYPTION_KEY is not set on the server; passwords and tokens cannot be saved yet.</div>}
        <label className="field">Type
          <select value={type} disabled={!!target} onChange={e => { setType(e.target.value as TargetType); setConfig({}); setSecrets({}) }}>
            {TYPE_ORDER.map(k => <option key={k} value={k}>{types[k]?.label ?? k}</option>)}
          </select>
        </label>
        <label className="field">Name<input value={name} placeholder="e.g. Office NAS" onChange={e => setName(e.target.value)} /></label>

        {type === 'sftp' && <>
          <div className="row wrap">
            <label className="field grow">Host<input value={cfg('host')} placeholder="nas.example.com" onChange={e => setCfg('host', e.target.value)} /></label>
            <label className="field">Port<input type="number" min={1} max={65535} value={cfg('port', '22')} onChange={e => setCfg('port', e.target.value)} /></label>
          </div>
          <label className="field">User<input value={cfg('user')} autoComplete="off" onChange={e => setCfg('user', e.target.value)} /></label>
          <label className="field">Password
            <input type="password" autoComplete="new-password" value={secrets.pass ?? ''} placeholder={secretPlaceholder('pass')} onChange={e => setSec('pass', e.target.value)} />
          </label>
          <label className="field">SSH private key (optional, instead of a password)
            <textarea rows={4} spellCheck={false} value={secrets.key_pem ?? ''} placeholder={has('key_pem') ? 'Saved. Leave blank to keep it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'} onChange={e => setSec('key_pem', e.target.value)} />
          </label>
        </>}

        {type === 's3' && <>
          <label className="field">Provider
            <select value={cfg('provider', 'Other')} onChange={e => setCfg('provider', e.target.value)}>
              {S3_PROVIDERS.map(p => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label className="field">Endpoint URL (leave blank for AWS)<input value={cfg('endpoint')} placeholder="https://s3.example.com" onChange={e => setCfg('endpoint', e.target.value)} /></label>
          <div className="row wrap">
            <label className="field grow">Bucket<input value={cfg('bucket')} onChange={e => setCfg('bucket', e.target.value)} /></label>
            <label className="field">Region<input value={cfg('region')} placeholder="auto" onChange={e => setCfg('region', e.target.value)} /></label>
          </div>
          <label className="field">Access key ID<input value={cfg('access_key_id')} autoComplete="off" onChange={e => setCfg('access_key_id', e.target.value)} /></label>
          <label className="field">Secret access key
            <input type="password" autoComplete="new-password" value={secrets.secret_access_key ?? ''} placeholder={secretPlaceholder('secret_access_key')} onChange={e => setSec('secret_access_key', e.target.value)} />
          </label>
        </>}

        {oauth && <>
          <div className="backup-help">
            <strong>Authorize once on any computer with rclone installed</strong> (rclone.org/downloads):
            <pre>{authCmd}</pre>
            A browser opens to sign in. When it finishes, rclone prints a line of JSON starting with <code>{'{"access_token"'}</code>. Paste it below.
            <details>
              <summary className="small">Using your own client ID / secret</summary>
              <pre>{customCmd}</pre>
              <span className="small muted">Then enter the same client ID and secret under Advanced.</span>
            </details>
          </div>
          <label className="field">Token JSON
            <textarea rows={4} spellCheck={false} value={secrets.token ?? ''} placeholder={has('token') ? 'Saved. Leave blank to keep it, or paste a new token.' : '{"access_token":"...","token_type":"Bearer","refresh_token":"...","expiry":"..."}'} onChange={e => setSec('token', e.target.value)} />
          </label>
          {type === 'zoho' && (
            <label className="field">Zoho data centre
              <select value={cfg('region', 'com')} onChange={e => setCfg('region', e.target.value)}>{ZOHO_REGIONS.map(r => <option key={r}>{r}</option>)}</select>
            </label>
          )}
          <details>
            <summary className="small">Advanced</summary>
            <label className="field">Client ID<input value={cfg('client_id')} onChange={e => setCfg('client_id', e.target.value)} /></label>
            <label className="field">Client secret
              <input type="password" autoComplete="new-password" value={secrets.client_secret ?? ''} placeholder={secretPlaceholder('client_secret')} onChange={e => setSec('client_secret', e.target.value)} />
            </label>
            {type === 'onedrive' && <>
              <label className="field">Drive type (personal, business or documentLibrary)<input value={cfg('drive_type')} onChange={e => setCfg('drive_type', e.target.value)} /></label>
              <label className="field">Drive ID<input value={cfg('drive_id')} onChange={e => setCfg('drive_id', e.target.value)} /></label>
              <span className="small muted">Normally filled in automatically from the token.</span>
            </>}
            {type === 'drive' && <label className="field">Root folder ID<input value={cfg('root_folder_id')} onChange={e => setCfg('root_folder_id', e.target.value)} /></label>}
          </details>
        </>}

        <label className="field">Folder on the remote{type === 's3' ? ' (prefix inside the bucket)' : ''}<input value={path} onChange={e => setPath(e.target.value)} /></label>
        <label className="field">Delete remote backups older than (days, 0 = keep forever)
          <input type="number" min={0} max={3650} value={days} onChange={e => setDays(e.target.value)} />
        </label>

        <label className="check"><input type="checkbox" checked={crypt} onChange={e => setCrypt(e.target.checked)} /> Encrypt backups before upload (rclone crypt)</label>
        {crypt && <>
          <label className="field">Passphrase
            <input type="password" autoComplete="new-password" value={cryptPw} placeholder={target?.crypt.has_password ? 'Saved. Leave blank to keep it.' : ''} onChange={e => setCryptPw(e.target.value)} />
          </label>
          <div className="backup-help small">
            File names and contents are encrypted on the server before they leave it. <strong>Keep the passphrase somewhere safe: without it the copies on the remote cannot be restored.</strong>
            Changing it later makes older uploads unreadable.
          </div>
        </>}
        <label className="check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled</label>

        {error && <div className="error">{error}</div>}
        <div className="row"><button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button><button onClick={onClose}>Cancel</button></div>
        <p className="muted small">After saving, use “Test connection” on the target.</p>
      </aside>
    </div>
  )
}
