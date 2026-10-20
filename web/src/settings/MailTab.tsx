import { useState } from 'react'
import { api } from '../api'
import { useAdminSettings } from './useAdminSettings'

export function MailTab() {
  const { settings, setSettings, error, save } = useAdminSettings()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [to, setTo] = useState('')
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (!settings) return <p className="muted">{error || 'Loading…'}</p>
  const m = settings.smtp
  const patch = (p: Partial<typeof m>) => setSettings({ ...settings, smtp: { ...m, ...p } })

  async function submit() {
    setMsg(''); setErr('')
    try { await save({ smtp: { ...m, pass: m.pass ?? '' } }); setMsg('Saved') } catch (e) { setErr((e as Error).message) }
  }

  async function sendTest() {
    setTestMsg(null)
    try { await api('/settings/test-email', { method: 'POST', body: JSON.stringify({ to }) }); setTestMsg({ ok: true, text: `Sent to ${to}` }) }
    catch (e) { setTestMsg({ ok: false, text: (e as Error).message }) }
  }

  return (
    <div className="settings-grid">
      <section className="card settings-card">
        <h3>Email (SMTP)</h3>
        <p className="muted small">Optional. With email set up, invites and password resets are also emailed. Without it, copy the link and send it yourself.</p>
        <label className="field">SMTP host<input value={m.host} placeholder="smtp.example.com" onChange={e => patch({ host: e.target.value })} /></label>
        <div className="row wrap">
          <label className="field grow">Port<input type="number" min={1} max={65535} value={m.port} onChange={e => patch({ port: Number(e.target.value) })} /></label>
          <label className="check"><input type="checkbox" checked={m.secure} onChange={e => patch({ secure: e.target.checked })} /> Use TLS (port 465)</label>
        </div>
        <label className="field">Username<input value={m.user} autoComplete="off" onChange={e => patch({ user: e.target.value })} /></label>
        <label className="field">Password
          <input type="password" autoComplete="new-password" value={m.pass ?? ''} placeholder={m.pass_set ? 'Saved. Leave blank to keep it.' : ''} onChange={e => patch({ pass: e.target.value })} />
        </label>
        <label className="field">From address<input value={m.from} placeholder="PlanAsBuilt &lt;noreply@example.com&gt;" onChange={e => patch({ from: e.target.value })} /></label>
        {err && <div className="error">{err}</div>}
        <div className="row"><button className="primary" onClick={submit}>Save changes</button>{msg && <span className="muted small" role="status">{msg}</span>}</div>
      </section>
      <section className="card settings-card">
        <h3>Send a test email</h3>
        <p className="muted small">Save the settings first, then send a test.</p>
        <div className="row"><input type="email" placeholder="you@example.com" value={to} onChange={e => setTo(e.target.value)} />
          <button disabled={!to} onClick={sendTest}>Send test</button></div>
        {testMsg && <div className={testMsg.ok ? 'muted small' : 'error'} role="status">{testMsg.text}</div>}
      </section>
    </div>
  )
}
