import { useEffect, useState } from 'react'
import { api } from '../api'
import { formatBytes } from './types'
import type { CleanupPreview, Usage } from './types'
import { useAdminSettings } from './useAdminSettings'

export function StorageTab() {
  const { settings, setSettings, error, save } = useAdminSettings()
  const [usage, setUsage] = useState<Usage | null>(null)
  const [usageError, setUsageError] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [cleaning, setCleaning] = useState(false)

  const loadUsage = () => api<Usage>('/storage/usage').then(setUsage).catch(e => setUsageError(e.message))
  useEffect(() => { void loadUsage() }, [])

  if (!settings) return <p className="muted">{error || 'Loading…'}</p>
  const s = settings
  const s3 = s.storage.s3
  const patchS3 = (p: Partial<typeof s3>) => setSettings({ ...s, storage: { ...s.storage, s3: { ...s3, ...p } } })

  async function saveAll() {
    setMsg(''); setErr('')
    try {
      await save({
        storage: { backend: s.storage.backend, s3: { ...s3, secret: s3.secret ?? '' } },
        retention: s.retention,
        photos: { max_dimension: s.photos.max_dimension },
      })
      setMsg('Saved'); void loadUsage()
    } catch (e) { setErr((e as Error).message) }
  }

  async function test() {
    setTesting(true); setTestResult(null)
    try {
      await api('/storage/test', { method: 'POST', body: JSON.stringify({ s3: { ...s3, secret: s3.secret ?? '' } }) })
      setTestResult({ ok: true, text: 'Connected. A small test file was written and deleted.' })
    } catch (e) { setTestResult({ ok: false, text: (e as Error).message }) }
    finally { setTesting(false) }
  }

  async function showCleanup() {
    setErr('')
    try { await save({ retention: s.retention }); setPreview(await api<CleanupPreview>('/storage/cleanup')) }
    catch (e) { setErr((e as Error).message) }
  }

  async function runCleanup() {
    if (!preview || preview.candidates.length === 0) return
    if (!confirm(`Permanently remove ${preview.candidates.length} old revision${preview.candidates.length === 1 ? '' : 's'}? This frees about ${formatBytes(preview.reclaim_bytes)} and cannot be undone.`)) return
    setCleaning(true); setErr('')
    try {
      const r = await api<{ removed: number; freed_bytes: number }>('/storage/cleanup', { method: 'POST', body: JSON.stringify({ ids: preview.candidates.map(c => c.id) }) })
      setMsg(`Removed ${r.removed} revision${r.removed === 1 ? '' : 's'}, freed ${formatBytes(r.freed_bytes)}.`)
      setPreview(null); void loadUsage()
    } catch (e) { setErr((e as Error).message) }
    finally { setCleaning(false) }
  }

  return (
    <div className="settings-grid">
      <section className="card settings-card wide">
        <h3>Storage used</h3>
        {usageError && <div className="error">{usageError}</div>}
        {!usage ? <p className="muted">Calculating…</p> : (
          <>
            <div className="usage-tiles">
              <div className="usage-tile"><span className="muted small">Database</span><strong>{formatBytes(usage.db_bytes)}</strong></div>
              <div className="usage-tile"><span className="muted small">Files</span><strong>{formatBytes(usage.files.total_bytes)}</strong>
                {usage.files.s3_bytes > 0 && <span className="muted small">{formatBytes(usage.files.local_bytes)} on this server, {formatBytes(usage.files.s3_bytes)} in the bucket</span>}</div>
              {usage.files.categories.map(c => (
                <div className="usage-tile" key={c.id}><span className="muted small">{c.label}</span><strong>{formatBytes(c.bytes)}</strong></div>
              ))}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Project</th><th className="num">Plans</th><th className="num">Photos</th><th className="num">Total</th><th className="num">Files</th></tr></thead>
                <tbody>
                  {usage.projects.length === 0 && <tr><td colSpan={5} className="muted">No projects yet.</td></tr>}
                  {usage.projects.map(p => (
                    <tr key={p.id}><td>{p.name}</td><td className="num">{formatBytes(p.plans_bytes)}</td><td className="num">{formatBytes(p.photos_bytes)}</td>
                      <td className="num">{formatBytes(p.total_bytes)}</td><td className="num">{p.file_count}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="card settings-card">
        <h3>Where files are stored</h3>
        <label className="field">Storage for new files
          <select value={s.storage.backend} onChange={e => setSettings({ ...s, storage: { ...s.storage, backend: e.target.value as 'local' | 's3' } })}>
            <option value="local">This server's disk</option>
            <option value="s3">S3-compatible bucket (AWS S3, Cloudflare R2, MinIO)</option>
          </select>
        </label>
        <p className="muted small">Switching only affects files uploaded afterwards. Existing files stay where they are and keep working.</p>
        {(s.storage.backend === 's3' || s3.bucket) && (
          <>
            <label className="field">Endpoint<input value={s3.endpoint} placeholder="https://ACCOUNT.r2.cloudflarestorage.com" onChange={e => patchS3({ endpoint: e.target.value })} /></label>
            <div className="row wrap">
              <label className="field grow">Bucket<input value={s3.bucket} onChange={e => patchS3({ bucket: e.target.value })} /></label>
              <label className="field grow">Region<input value={s3.region} placeholder="auto" onChange={e => patchS3({ region: e.target.value })} /></label>
            </div>
            <label className="field">Access key ID<input value={s3.accessKeyId} autoComplete="off" onChange={e => patchS3({ accessKeyId: e.target.value })} /></label>
            <label className="field">Secret access key
              <input type="password" value={s3.secret ?? ''} autoComplete="new-password"
                placeholder={s3.secret_set ? 'Saved. Leave blank to keep it.' : ''} onChange={e => patchS3({ secret: e.target.value })} />
            </label>
            <label className="field">Folder prefix (optional)<input value={s3.prefix} placeholder="planmark/" onChange={e => patchS3({ prefix: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={s3.pathStyle} onChange={e => patchS3({ pathStyle: e.target.checked })} /> Use path-style URLs (MinIO and some gateways)</label>
            <div className="row">
              <button type="button" disabled={testing} onClick={test}>{testing ? 'Testing…' : 'Test connection'}</button>
              {testResult && <span className={testResult.ok ? 'muted small' : 'error'} role="status">{testResult.text}</span>}
            </div>
          </>
        )}
      </section>

      <section className="card settings-card">
        <h3>Photos and revisions</h3>
        <label className="field">Photo longest side (pixels)
          <input type="number" min={800} max={6000} step={100} value={s.photos.max_dimension}
            onChange={e => setSettings({ ...s, photos: { max_dimension: Number(e.target.value) } })} />
        </label>
        <label className="field">Revision retention
          <select value={s.retention.mode} onChange={e => setSettings({ ...s, retention: { ...s.retention, mode: e.target.value as 'all' | 'keep' } })}>
            <option value="all">Keep every revision</option>
            <option value="keep">Keep issued revisions and the newest uploads</option>
          </select>
        </label>
        {s.retention.mode === 'keep' && (
          <label className="field">Uploads to keep per plan
            <input type="number" min={1} max={100} value={s.retention.keep_latest}
              onChange={e => setSettings({ ...s, retention: { ...s.retention, keep_latest: Number(e.target.value) } })} />
          </label>
        )}
        <div className="row">
          <button type="button" disabled={s.retention.mode !== 'keep'} onClick={showCleanup}
            title={s.retention.mode === 'keep' ? 'See what would be removed first' : 'Choose a retention rule first'}>Clean up now…</button>
        </div>
        {preview && (
          <div className="cleanup-preview">
            {preview.candidates.length === 0 ? <p className="muted">Nothing to remove under this rule.</p> : (
              <>
                <p>These {preview.candidates.length} revision{preview.candidates.length === 1 ? '' : 's'} would be removed, freeing about {formatBytes(preview.reclaim_bytes)}:</p>
                <ul className="cleanup-list small">
                  {preview.candidates.map(c => (
                    <li key={c.id}>{c.project} / {c.document}: Rev {c.revision}{c.label ? ` (${c.label})` : ''}, {new Date(c.created_at).toLocaleDateString()}
                      <span className="muted"> · {c.file_kept ? 'file still used elsewhere' : formatBytes(c.bytes)}</span></li>
                  ))}
                </ul>
                <div className="row"><button className="danger" disabled={cleaning} onClick={runCleanup}>{cleaning ? 'Removing…' : `Remove ${preview.candidates.length}`}</button>
                  <button onClick={() => setPreview(null)}>Cancel</button></div>
              </>
            )}
          </div>
        )}
      </section>

      <div className="settings-actions">
        {err && <div className="error">{err}</div>}
        <div className="row"><button className="primary" onClick={saveAll}>Save changes</button>{msg && <span className="muted small" role="status">{msg}</span>}</div>
      </div>
    </div>
  )
}
