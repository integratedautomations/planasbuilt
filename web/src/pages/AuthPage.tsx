import { FormEvent, useEffect, useState } from 'react'
import { api, post, User } from '../api'
import { Brand } from '../Brand'

interface Props { onSignedIn: (token: string, user: User) => void }

export function AuthPage({ onSignedIn }: Props) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)

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
        ? await post<{ token: string; user: User }>('/auth/setup', { email, name, password, setupCode: setupCode.trim() })
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
        <h1 className="brand"><Brand /></h1>
        <p className="muted">
          {needsSetup ? 'Create the first admin account.' : 'Sign in to your team workspace.'}
        </p>
        {needsSetup && (
          <label>Setup code
            <input value={setupCode} onChange={e => setSetupCode(e.target.value)} required autoComplete="off" spellCheck={false} />
            <span className="muted small">Printed in the server log on first start (<code>docker compose logs app</code>), or the SETUP_TOKEN you configured.</span>
          </label>
        )}
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
        {needsSetup === false && (
          forgot
            ? <p className="muted small" role="status">Ask your admin for a password reset link. They can create one for you under Users.</p>
            : <button type="button" className="link-btn forgot" onClick={() => setForgot(true)}>Forgot password?</button>
        )}
      </form>
    </div>
  )
}
