import { FormEvent, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { api, setToken, User } from '../api'
import { UserAvatar } from '../ui/UserAvatar'


/** Accessible backgrounds (each has >= 4.5:1 contrast with white or black text). */
const AVATAR_COLORS = ['#c92a2a', '#d9480f', '#e67700', '#2b8a3e', '#087f5b', '#0b7285', '#1971c2', '#5f3dc4', '#a61e4d', '#495057']

export function PersonalTab({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const [name, setName] = useState(user.name)
  const [nameMsg, setNameMsg] = useState('')
  const [pw, setPw] = useState({ current: '', next: '', again: '' })
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [picMsg, setPicMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function uploadPicture(file: File | undefined) {
    if (!file) return
    setPicMsg('')
    try {
      const fd = new FormData(); fd.append('photo', file)
      const r = await api<{ avatar: number | null }>('/me/avatar', { method: 'POST', body: fd })
      onUser({ ...user, avatar: r.avatar })
    } catch (err) { setPicMsg((err as Error).message) }
    if (fileRef.current) fileRef.current.value = ''
  }
  async function removePicture() {
    setPicMsg('')
    try { await api('/me/avatar', { method: 'DELETE' }); onUser({ ...user, avatar: null }) } catch (err) { setPicMsg((err as Error).message) }
  }

  async function pickColor(color: string | null) {
    setPicMsg('')
    try {
      const r = await api<{ avatar_color: string | null }>('/me/avatar-color', { method: 'PUT', body: JSON.stringify({ color }) })
      onUser({ ...user, avatar_color: r.avatar_color })
    } catch (err) { setPicMsg((err as Error).message) }
  }

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
      const res = await api<{ token?: string }>('/me/password', { method: 'POST', body: JSON.stringify({ current: pw.current, password: pw.next }) })
      if (res?.token) setToken(res.token) // the old session token stops working after a password change
      setPw({ current: '', next: '', again: '' }); setPwMsg({ ok: true, text: 'Password changed' })
    } catch (err) { setPwMsg({ ok: false, text: (err as Error).message }) }
  }

  return (
    <div className="settings-grid">
      <section className="card settings-card">
        <h3><Icon name="user" size={18} /> Profile</h3>
        <div className="row">
          <UserAvatar userId={user.id} name={user.name} avatar={user.avatar} color={user.avatar_color} size={56} />
          <button type="button" onClick={() => fileRef.current?.click()}>{user.avatar != null ? 'Change picture' : 'Upload picture'}</button>
          {user.avatar != null && <button type="button" onClick={removePicture}>Remove</button>}
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => uploadPicture(e.target.files?.[0])} />
          {picMsg && <span className="error small">{picMsg}</span>}
        </div>
        {user.avatar == null && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="small muted">Initials background</span>
            <div className="row wrap" style={{ gap: 6 }} role="radiogroup" aria-label="Initials background colour">
              {AVATAR_COLORS.map(c => (
                <button key={c} type="button" role="radio" aria-checked={user.avatar_color === c} aria-label={`Colour ${c}`} title={c} onClick={() => void pickColor(c)}
                  style={{ width: 28, height: 28, minHeight: 0, padding: 0, borderRadius: '50%', background: c, border: user.avatar_color === c ? '3px solid var(--text)' : '2px solid var(--border)' }} />
              ))}
              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Custom
                <input type="color" value={user.avatar_color ?? '#1c7ed6'} onChange={e => void pickColor(e.target.value)} aria-label="Custom colour" style={{ width: 32, height: 28, padding: 0 }} />
              </label>
              {user.avatar_color && <button type="button" className="small" onClick={() => void pickColor(null)}>Automatic</button>}
            </div>
          </div>
        )}
        <form className="stack" onSubmit={saveName}>
          <label className="field">Name<input value={name} onChange={e => setName(e.target.value)} required /></label>
          <label className="field">Email<input value={user.email} readOnly disabled /></label>
          <div className="row"><button className="primary" disabled={!name.trim() || name === user.name}>Save</button>{nameMsg && <span className="muted small">{nameMsg}</span>}</div>
        </form>
      </section>

      <section className="card settings-card">
        <h3><Icon name="lock" size={18} /> Change password</h3>
        <form className="stack" onSubmit={changePassword}>
          <label className="field">Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} required /></label>
          <label className="field">New password (8+ characters)<input type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} required /></label>
          <label className="field">Repeat new password<input type="password" autoComplete="new-password" minLength={8} value={pw.again} onChange={e => setPw({ ...pw, again: e.target.value })} required /></label>
          {pwMsg && <div className={pwMsg.ok ? 'muted small' : 'error'}>{pwMsg.text}</div>}
          <div><button className="primary">Change password</button></div>
        </form>
      </section>

    </div>
  )
}
