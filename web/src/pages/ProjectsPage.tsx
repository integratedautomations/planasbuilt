import { FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post, Project, User } from '../api'
import { UsersDialog } from './UsersDialog'

interface Props { user: User; onSignOut: () => void }

export function ProjectsPage({ user, onSignOut }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [showUsers, setShowUsers] = useState(false)

  useEffect(() => { api<Project[]>('/projects').then(setProjects).catch(e => setError(e.message)) }, [])

  async function create(e: FormEvent) {
    e.preventDefault()
    try {
      const p = await post<Project>('/projects', { name })
      setProjects(ps => [{ ...p, document_count: 0 }, ...(ps ?? [])])
      setName('')
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand">PlanMark</span>
        <span className="spacer" />
        <Link to="/symbols" className="btn-link">Symbols</Link>
        {user.is_admin && <button onClick={() => setShowUsers(true)}>Users</button>}
        <span className="muted hide-sm">{user.name}</span>
        <button onClick={onSignOut}>Sign out</button>
      </header>
      <main className="content">
        <h2>Projects</h2>
        <form className="row" onSubmit={create}>
          <input placeholder="New project name" value={name} onChange={e => setName(e.target.value)} required />
          <button className="primary">Create</button>
        </form>
        {error && <div className="error">{error}</div>}
        {projects === null ? <p className="muted">Loading…</p> : projects.length === 0 ? (
          <p className="muted">No projects yet. Create one above.</p>
        ) : (
          <ul className="list">
            {projects.map(p => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="list-item">
                  <span className="list-title">{p.name}</span>
                  <span className="muted">{p.document_count} plan{p.document_count === 1 ? '' : 's'} · {p.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      {showUsers && <UsersDialog onClose={() => setShowUsers(false)} />}
    </div>
  )
}
