import { FormEvent, useEffect, useState } from 'react'
import { api, post, User } from '../api'

export function UsersDialog({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [form, setForm] = useState({ name: '', email: '', password: '', isAdmin: false })
  const [error, setError] = useState('')

  useEffect(() => { api<User[]>('/users').then(setUsers).catch(e => setError(e.message)) }, [])

  async function add(e: FormEvent) {
    e.preventDefault(); setError('')
    try {
      const u = await post<User>('/users', form)
      setUsers(us => [...us, u].sort((a, b) => a.name.localeCompare(b.name)))
      setForm({ name: '', email: '', password: '', isAdmin: false })
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>Team users</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        <ul className="list compact">
          {users.map(u => <li key={u.id} className="list-item">{u.name} <span className="muted">{u.email}{u.is_admin ? ' · admin' : ''}</span></li>)}
        </ul>
        <form className="stack" onSubmit={add}>
          <h4>Add user</h4>
          <input placeholder="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
          <input placeholder="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
          <input placeholder="Temporary password (8+ chars)" type="password" minLength={8} autoComplete="new-password"
            value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
          <label className="check"><input type="checkbox" checked={form.isAdmin}
            onChange={e => setForm({ ...form, isAdmin: e.target.checked })} /> App admin</label>
          {error && <div className="error">{error}</div>}
          <button className="primary">Add user</button>
        </form>
      </div>
    </div>
  )
}
