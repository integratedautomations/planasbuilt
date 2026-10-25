import { FormEvent, useState } from 'react'
import type { AdminSettings } from './types'
import { useAdminSettings } from './useAdminSettings'

/** Platform admins: install-wide sign-in rules, upload size and how long deleted files wait in the trash. */
export function SecurityPanel() {
  const { settings, setSettings, error, save } = useAdminSettings()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  if (!settings) return <p className="muted">{error || 'Loading...'}</p>
  const s = settings
  const patch = <K extends 'security' | 'uploads'>(k: K, p: Partial<AdminSettings[K]>) => { setSettings({ ...s, [k]: { ...s[k], ...p } }); setMsg('') }

  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(''); setErr(''); setBusy(true)
    try {
      await save({ security: s.security, uploads: s.uploads, retention: s.retention })
      setMsg('Saved')
    } catch (e2) { setErr((e2 as Error).message) } finally { setBusy(false) }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <p className="muted small">These apply to the whole installation, for every company.</p>
      <div className="tidy-grid">
        <section className="card settings-card">
          <h3>Sign-in and sessions</h3>
          <label className="field">Stay signed in for (days)
            <input type="number" min={1} max={365} value={s.security.session_days} onChange={e => patch('security', { session_days: Number(e.target.value) })} />
          </label>
          <label className="field">Lock an account after this many wrong passwords
            <input type="number" min={0} max={100} value={s.security.lockout_limit} onChange={e => patch('security', { lockout_limit: Number(e.target.value) })} />
          </label>
          <label className="field">First lock lasts (minutes)
            <input type="number" min={1} max={60} value={s.security.lockout_base_min} onChange={e => patch('security', { lockout_base_min: Number(e.target.value) })} />
          </label>
          <label className="field">Longest lock (minutes)
            <input type="number" min={1} max={1440} value={s.security.lockout_cap_min} onChange={e => patch('security', { lockout_cap_min: Number(e.target.value) })} />
          </label>
          <p className="muted small">0 wrong passwords means the built-in limit (10). Each further failure doubles the lock up to the longest. A new session length applies to people who sign in from now on.</p>
        </section>

        <section className="card settings-card">
          <h3>Uploads and trash</h3>
          <label className="field">Largest file (MB)
            <input type="number" min={1} max={1024} value={s.uploads.max_upload_mb} onChange={e => patch('uploads', { max_upload_mb: Number(e.target.value) })} />
          </label>
          <p className="muted small">Applies to plan PDFs and revisions. Photos are also capped at 15 MB.</p>
          <label className="field">Days to keep deleted files (0 = delete at once)
            <input type="number" min={0} max={3650} value={s.retention.trash_days ?? 30}
              onChange={e => { setSettings({ ...s, retention: { ...s.retention, trash_days: Number(e.target.value) } }); setMsg('') }} />
            <span className="muted small">Deleted photos and plans wait in the _trash folder for this long, so a mistake can be undone by moving the file back.</span>
          </label>
        </section>
      </div>
      <div className="save-bar">
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row"><button className="primary" disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button>{msg && <span className="muted small" role="status">{msg}</span>}</div>
      </div>
    </form>
  )
}
