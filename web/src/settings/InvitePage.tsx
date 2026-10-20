import { FormEvent, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, post } from '../api'
import type { User } from '../api'
import { Brand } from '../Brand'

interface TokenInfo { purpose: 'invite' | 'reset'; email: string; name: string; inviter: string | null; company: string; expires_at: string }

/** Public page behind /invite/:token and /reset/:token: set a password (and name for invites), then sign in. */
export function InvitePage({ purpose, onSignedIn }: { purpose: 'invite' | 'reset'; onSignedIn: (token: string, user: User) => void }) {
  const { token } = useParams()
  const base = purpose === 'invite' ? '/invites' : '/resets'
  const [info, setInfo] = useState<TokenInfo | null>(null)
  const [problem, setProblem] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<TokenInfo>(`${base}/${encodeURIComponent(token ?? '')}`)
      .then(i => { setInfo(i); setName(i.name) })
      .catch(e => setProblem(e.message))
  }, [base, token])

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('')
    if (password !== again) { setError('The passwords do not match'); return }
    setBusy(true)
    try {
      const res = await post<{ token: string; user: User }>(`${base}/${encodeURIComponent(token ?? '')}/accept`, { name, password })
      onSignedIn(res.token, res.user)
      window.history.replaceState(null, '', '/')
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="center">
      <form className="card auth-card" onSubmit={submit}>
        <h1 className="brand"><Brand /></h1>
        {problem ? (
          <>
            <div className="error">{problem}</div>
            <a className="btn-link" href="/">Go to sign in</a>
          </>
        ) : !info ? <p className="muted">Checking your link…</p> : (
          <>
            <p className="muted">
              {purpose === 'invite'
                ? `${info.inviter ? `${info.inviter} invited you` : 'You were invited'}${info.company ? ` to ${info.company}` : ''}. Choose a password to finish setting up ${info.email}.`
                : `Choose a new password for ${info.email}.`}
            </p>
            {purpose === 'invite' && (
              <label>Your name<input value={name} onChange={e => setName(e.target.value)} required autoComplete="name" /></label>
            )}
            <label>{purpose === 'invite' ? 'Password' : 'New password'} (8+ characters)
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
            </label>
            <label>Repeat password
              <input type="password" value={again} onChange={e => setAgain(e.target.value)} required minLength={8} autoComplete="new-password" />
            </label>
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy}>{purpose === 'invite' ? 'Join and sign in' : 'Set password and sign in'}</button>
          </>
        )}
      </form>
    </div>
  )
}
