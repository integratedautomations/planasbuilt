import { FormEvent, useEffect, useState } from 'react'
import { api, post, User } from '../api'

interface Props { onSignedIn: (token: string, user: User) => void }

export function AuthPage({ onSignedIn }: Props) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ needsSetup: boolean }>('/auth/status')
      .then(r => setNeedsSetup(r.needsSetup))
      .catch(() => setError('Cannot reach the server'))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res = needsSetup
        ? await post<{ token: string; user: User }>('/auth/setup', { email, name, password })
        : await post<{ token: string; user: User }>('/auth/login', { email, password })
      onSignedIn(res.token, res.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <form className="card auth-card" onSubmit={submit}>
        <h1 className="brand">PlanMark</h1>
        <p className="muted">
          {needsSetup ? 'Create the first admin account.' : 'Sign in to your team workspace.'}
        </p>
        {needsSetup && (
          <label>Name<input value={name} onChange={e => setName(e.target.value)} required autoComplete="name" /></label>
        )}
        <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" /></label>
        <label>Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
            minLength={needsSetup ? 8 : undefined} autoComplete={needsSetup ? 'new-password' : 'current-password'} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy || needsSetup === null}>
          {needsSetup ? 'Create admin' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
