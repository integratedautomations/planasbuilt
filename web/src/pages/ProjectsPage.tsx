import { FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { post, Project, User } from '../api'
import { loadProjects } from '../offline/cache'
import { OfflineBanner } from '../offline/OfflineBanner'
import { UserMenu } from '../settings/UserMenu'
import { Brand } from '../Brand'
import { Icon } from '../ui/Icon'

interface Props { user: User; onSignOut: () => void }

export function ProjectsPage(_: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)

  useEffect(() => { loadProjects().then(r => setProjects(r.data)).catch(e => setError(e.message)) }, [])

  async function create(e: FormEvent) {
    e.preventDefault()
    try {
      const p = await post<Project>('/projects', { name })
      setProjects(ps => [{ ...p, document_count: 0 }, ...(ps ?? [])])
      setName('')
    } catch (err) { setError((err as Error).message) }
  }

  const open = (projects ?? []).filter(p => p.status !== 'completed')
  const done = (projects ?? []).filter(p => p.status === 'completed')

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand"><Brand onChrome /></span>
        <span className="spacer" />
        <Link to="/symbols" className="btn-link">Catalog</Link>
        <UserMenu />
      </header>
      <OfflineBanner />
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
          <>
            <h3 className="muted">Open ({open.length})</h3>
            {open.length === 0 ? <p className="muted">No open projects.</p> : <ProjectList projects={open} />}
            {done.length > 0 && <>
              <h3>
                <button type="button" className="link-btn" aria-expanded={showCompleted} onClick={() => setShowCompleted(v => !v)}>
                  <Icon name={showCompleted ? 'chevron-down' : 'chevron-right'} size={16} /> Completed ({done.length})
                </button>
              </h3>
              {showCompleted && <ProjectList projects={done} />}
            </>}
          </>
        )}
      </main>
    </div>
  )
}

function ProjectList({ projects }: { projects: Project[] }) {
  return (
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
  )
}
