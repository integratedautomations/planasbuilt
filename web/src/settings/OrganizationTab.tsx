import { FormEvent, useEffect, useState } from 'react'
import type { SymbolSet } from '../markups/types'
import { loadSymbolSets } from '../offline/cache'
import { normalizeSettings } from '../projectSettings'
import type { ProjectRules } from '../projectSettings'
import { ProjectRulesForm } from './ProjectRulesForm'
import type { AdminSettings } from './types'
import { useAdminSettings } from './useAdminSettings'

const PLACEHOLDERS = ['{name}', '{inviter}', '{company}', '{link}', '{days}']
const SAMPLE = { name: 'Alex', inviter: 'Sam', company: 'Your Company', link: 'https://example.com/invite/...', days: '7' }
const preview = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: keyof typeof SAMPLE) => SAMPLE[k] ?? m)

/** Rules a new project starts with (a copy; existing projects are not touched). */
const rulesOf = (raw: unknown): ProjectRules => {
  const s = normalizeSettings(raw)
  return { statuses: s.statuses, required: s.required, tag_prefixes: s.tag_prefixes, tag_format: s.tag_format, tag_fill_gaps: s.tag_fill_gaps, report: { sections: s.report.sections }, photo_quality: s.photo_quality }
}

/** Organization settings (app admins): sign-in rules, upload size, invite email and the defaults for new projects. Branding is on the Company tab. */
export function OrganizationTab() {
  const { settings, setSettings, error, save } = useAdminSettings()
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { loadSymbolSets().then(r => setSets([...r.data].sort((a, b) => a.sort - b.sort))).catch(() => {}) }, [])
  if (!settings) return <p className="muted">{error || 'Loading...'}</p>
  const s = settings
  const patch = <K extends 'security' | 'uploads' | 'invite'>(k: K, p: Partial<AdminSettings[K]>) => { setSettings({ ...s, [k]: { ...s[k], ...p } }); setMsg('') }
  const defaults = rulesOf(s.project_defaults)

  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(''); setErr(''); setBusy(true)
    try {
      await save({ security: s.security, uploads: s.uploads, invite: s.invite, project_defaults: s.project_defaults })
      setMsg('Saved')
    } catch (e2) { setErr((e2 as Error).message) } finally { setBusy(false) }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="settings-grid">
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
          <h3>Uploads</h3>
          <label className="field">Largest file (MB)
            <input type="number" min={1} max={1024} value={s.uploads.max_upload_mb} onChange={e => patch('uploads', { max_upload_mb: Number(e.target.value) })} />
          </label>
          <p className="muted small">Applies to plan PDFs and revisions. Photos are also capped at 15 MB.</p>
        </section>

        <section className="card settings-card">
          <h3>Invite email</h3>
          <label className="field">Sender name in the text
            <input value={s.invite.sender_name} placeholder="Blank = the name of the person who invites" onChange={e => patch('invite', { sender_name: e.target.value })} />
          </label>
          <label className="field">Subject
            <input value={s.invite.subject} onChange={e => patch('invite', { subject: e.target.value })} />
          </label>
          <label className="field">Message
            <textarea rows={8} value={s.invite.body} onChange={e => patch('invite', { body: e.target.value })} />
          </label>
          <p className="muted small">Placeholders: {PLACEHOLDERS.join(' ')}. The message must include {'{link}'}. Needs the email settings (Email tab) to send; otherwise you copy the link.</p>
          <details>
            <summary className="small">Preview</summary>
            <div className="small"><strong>{preview(s.invite.subject)}</strong></div>
            <pre className="small invite-preview">{preview(s.invite.body)}</pre>
          </details>
        </section>
      </div>

      <h3>Defaults for new projects</h3>
      <p className="muted small">New projects start with a copy of these. Changing them later does not touch projects that already exist.</p>
      <ProjectRulesForm value={defaults} sets={sets} disabled={busy}
        onChange={r => { setSettings({ ...s, project_defaults: r }); setMsg('') }} />

      <div className="settings-actions">
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row"><button className="primary" disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button>{msg && <span className="muted small" role="status">{msg}</span>}</div>
      </div>
    </form>
  )
}
