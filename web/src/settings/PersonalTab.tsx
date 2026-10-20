import { FormEvent, useState } from 'react'
import { api, User } from '../api'
import type { ReplaceChoice } from '../markups/placeReplace'
import { HotkeyDialog } from '../prefs/HotkeyDialog'
import { DENSITY_PREFS } from '../prefs/density'
import type { DensityPref } from '../prefs/density'
import { setPref, usePrefs } from '../prefs/store'
import { THEME_PREFS } from '../prefs/theme'
import type { ThemePref } from '../prefs/theme'

const THEME_LABEL: Record<ThemePref, string> = { auto: 'Match my device', light: 'Light', dark: 'Dark' }
const DENSITY_LABEL: Record<DensityPref, string> = { auto: 'Automatic (compact on desktop, comfortable on touch)', compact: 'Compact', comfortable: 'Comfortable' }

export function PersonalTab({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const prefs = usePrefs()
  const [name, setName] = useState(user.name)
  const [nameMsg, setNameMsg] = useState('')
  const [pw, setPw] = useState({ current: '', next: '', again: '' })
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [hotkeys, setHotkeys] = useState(false)

  async function saveName(e: FormEvent) {
    e.preventDefault(); setNameMsg('')
    try {
      const u = await api<User>('/me', { method: 'PATCH', body: JSON.stringify({ name }) })
      onUser({ ...user, name: u.name }); setNameMsg('Saved')
    } catch (err) { setNameMsg((err as Error).message) }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault(); setPwMsg(null)
    if (pw.next !== pw.again) { setPwMsg({ ok: false, text: 'The new passwords do not match' }); return }
    try {
      await api('/me/password', { method: 'POST', body: JSON.stringify({ current: pw.current, password: pw.next }) })
      setPw({ current: '', next: '', again: '' }); setPwMsg({ ok: true, text: 'Password changed' })
    } catch (err) { setPwMsg({ ok: false, text: (err as Error).message }) }
  }

  return (
    <div className="settings-grid">
      <section className="card settings-card">
        <h3>Profile</h3>
        <form className="stack" onSubmit={saveName}>
          <label className="field">Name<input value={name} onChange={e => setName(e.target.value)} required /></label>
          <label className="field">Email<input value={user.email} readOnly disabled /></label>
          <div className="row"><button className="primary" disabled={!name.trim() || name === user.name}>Save</button>{nameMsg && <span className="muted small">{nameMsg}</span>}</div>
        </form>
      </section>

      <section className="card settings-card">
        <h3>Change password</h3>
        <form className="stack" onSubmit={changePassword}>
          <label className="field">Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} required /></label>
          <label className="field">New password (8+ characters)<input type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} required /></label>
          <label className="field">Repeat new password<input type="password" autoComplete="new-password" minLength={8} value={pw.again} onChange={e => setPw({ ...pw, again: e.target.value })} required /></label>
          {pwMsg && <div className={pwMsg.ok ? 'muted small' : 'error'}>{pwMsg.text}</div>}
          <div><button className="primary">Change password</button></div>
        </form>
      </section>

      <section className="card settings-card">
        <h3>Appearance</h3>
        <label className="field">Theme
          <select value={prefs.theme} onChange={e => setPref('theme', e.target.value as ThemePref)}>
            {THEME_PREFS.map(t => <option key={t} value={t}>{THEME_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="field">Density
          <select value={prefs.density} onChange={e => setPref('density', e.target.value as DensityPref)}>
            {DENSITY_PREFS.map(d => <option key={d} value={d}>{DENSITY_LABEL[d]}</option>)}
          </select>
        </label>
        <p className="muted small">These follow you to every device you sign in on.</p>
      </section>

      <section className="card settings-card">
        <h3>Plan editing</h3>
        <label className="field">When I place a device on a device of another type
          <select value={prefs.replaceOnOverlap} onChange={e => setPref('replaceOnOverlap', e.target.value as ReplaceChoice)}>
            <option value="ask">Ask me</option>
            <option value="replace">Replace it</option>
            <option value="both">Place both</option>
          </select>
        </label>
        <div><button onClick={() => setHotkeys(true)}>Keyboard shortcuts…</button></div>
      </section>

      <section className="card settings-card">
        <h3>Notifications</h3>
        <p className="muted">Choose which events notify you, and how (in the app, email or push). Coming in M15.</p>
      </section>

      {hotkeys && <HotkeyDialog overrides={prefs.hotkeys} onChange={o => setPref('hotkeys', o)} onClose={() => setHotkeys(false)} />}
    </div>
  )
}
