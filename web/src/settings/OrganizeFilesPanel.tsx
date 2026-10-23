import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useSession } from './session'

interface Preview { scope: 'company' | 'all'; files: number; already_organized: number; to_move: number; legacy_to_move: number; samples: { from: string; to: string }[] }
interface Status { status: 'none' | 'pending' | 'running' | 'done' | 'failed'; total: number; moved: number; failed: number; error: string; queued_renames?: number }

/**
 * Storage > Organize files. Files are kept in readable folders (Company / Projects / Project / Plans or Photos / ...).
 * New files go there by themselves; this moves the files saved by older versions. Preview first, then apply; the move runs in
 * the background on the server, in batches, and can be left and resumed.
 */
export function OrganizeFilesPanel() {
  const session = useSession()
  const platform = !!session?.user.platform_admin
  const [everyCompany, setEveryCompany] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const timer = useRef<number | null>(null)
  const scope = everyCompany ? '?scope=all' : ''

  const load = useCallback(async () => {
    try { const s = await api<Status>(`/admin/storage/organize/status${scope}`); setStatus(s); return s } catch (e) { setErr((e as Error).message); return null }
  }, [scope])

  useEffect(() => { setPreview(null); void load() }, [load])
  const active = status?.status === 'pending' || status?.status === 'running'
  useEffect(() => {
    if (!active) return
    timer.current = window.setInterval(() => { void load() }, 1500)
    return () => { if (timer.current) window.clearInterval(timer.current) }
  }, [active, load])

  async function showPreview() {
    setBusy(true); setErr('')
    try { setPreview(await api<Preview>('/admin/storage/organize/preview', { method: 'POST', body: JSON.stringify({ scope: everyCompany ? 'all' : 'company' }) })) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function apply() {
    if (!preview || preview.to_move === 0) return
    if (!confirm(`Move ${preview.to_move} file${preview.to_move === 1 ? '' : 's'} into the readable folders? The app keeps working while it runs, and you can leave this page.`)) return
    setBusy(true); setErr('')
    try {
      setStatus(await api<Status>('/admin/storage/organize/apply', { method: 'POST', body: JSON.stringify({ scope: everyCompany ? 'all' : 'company' }) }))
      setPreview(null)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const pct = status && status.total > 0 ? Math.min(100, Math.round(((status.moved + status.failed) / status.total) * 100)) : 0
  return (
    <section className="settings-section">
      <h3>Organize files</h3>
      <p className="muted small">
        New files are saved in readable folders: Company / Projects / Project / Plans or Photos / Plan / Device. This moves files saved by
        older versions into the same folders. Nothing is lost: the app finds files by id, so names can change freely.
        Renaming a company, project, plan or device tag moves its files automatically.
      </p>
      {platform && (
        <label className="check"><input type="checkbox" checked={everyCompany} onChange={e => setEveryCompany(e.target.checked)} disabled={active} /> All companies (and profile pictures)</label>
      )}
      <div className="row">
        <button type="button" onClick={showPreview} disabled={busy || active}>Preview…</button>
      </div>
      {preview && (
        <div className="cleanup-preview">
          <p>{preview.files} file{preview.files === 1 ? '' : 's'} checked: {preview.already_organized} already in place, <strong>{preview.to_move}</strong> to move
            {preview.legacy_to_move > 0 && <> ({preview.legacy_to_move} with old numbered names)</>}.</p>
          {preview.samples.length > 0 && (
            <ul className="cleanup-list small">
              {preview.samples.map(s => <li key={s.from}><span className="muted">{s.from}</span> → {s.to}</li>)}
              {preview.to_move > preview.samples.length && <li className="muted">…and {preview.to_move - preview.samples.length} more</li>}
            </ul>
          )}
          <div className="row">
            <button type="button" className="primary" disabled={busy || preview.to_move === 0} onClick={apply}>Organize {preview.to_move} file{preview.to_move === 1 ? '' : 's'}</button>
            <button type="button" onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
      {status && status.status !== 'none' && (
        <div className="organize-status" role="status">
          {active && <progress max={100} value={pct} aria-label="Progress" style={{ width: '100%' }} />}
          <p className="small">
            {status.status === 'pending' && 'Waiting to start…'}
            {status.status === 'running' && `Moving files: ${status.moved + status.failed} of ${status.total}`}
            {status.status === 'done' && `Done: ${status.moved} moved${status.failed ? `, ${status.failed} could not be moved` : ''}.`}
            {status.status === 'failed' && 'Stopped after repeated errors.'}
          </p>
          {status.failed > 0 && status.error && <p className="error small">Last problem: {status.error}</p>}
        </div>
      )}
      {!!status?.queued_renames && <p className="muted small">{status.queued_renames} rename{status.queued_renames === 1 ? '' : 's'} waiting for their files to follow.</p>}
      {err && <div className="error">{err}</div>}
    </section>
  )
}
