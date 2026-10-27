import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post, Project, User } from '../api'
import { isStale, loadProjects } from '../offline/cache'
import { on as onSocket } from '../realtime/socket'
import { OfflineBanner } from '../offline/OfflineBanner'
import { UserMenu } from '../settings/UserMenu'
import { Brand } from '../Brand'
import { CompanySwitcher } from '../company/CompanySwitcher'
import { Icon } from '../ui/Icon'

interface Props { user: User; onSignOut: () => void }

export function ProjectsPage({ user }: Props) {
  const canCreate = !!(user.is_admin || user.can_create_projects)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const admin = !!user.is_admin

  const reload = useCallback(() => { loadProjects(admin && showArchived).then(r => setProjects(r.data)).catch(e => { if (!isStale(e)) setError(e.message) }) }, [admin, showArchived])
  useEffect(reload, [reload])
  // Another admin archived, restored or deleted a project: refresh the list.
  useEffect(() => onSocket('projects', reload), [reload])

  async function restore(p: Project) {
    try {
      await api(`/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) })
      reload()
    } catch (err) { setError((err as Error).message) }
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    try {
      const p = await post<Project>('/projects', { name })
      setProjects(ps => [{ ...p, document_count: 0 }, ...(ps ?? [])])
      setName('')
    } catch (err) { setError((err as Error).message) }
  }

  const open = (projects ?? []).filter(p => !p.archived && p.status !== 'completed')
  const done = (projects ?? []).filter(p => !p.archived && p.status === 'completed')
  const archived = (projects ?? []).filter(p => p.archived)

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand"><Brand onChrome /></span>
        <CompanySwitcher />
        <span className="spacer" />
        <Link to="/company/catalog" className="btn-link">Catalog</Link>
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content">
        <h2>Projects</h2>
        {canCreate && (
          <form className="row" onSubmit={create}>
            <input placeholder="New project name" value={name} onChange={e => setName(e.target.value)} required />
            <button className="primary">Create</button>
          </form>
        )}
        {admin && (
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
          </label>
        )}
        {error && <div className="error">{error}</div>}
        {projects === null ? <p className="muted">Loading…</p> : projects.length === 0 ? (
          <p className="muted">{canCreate ? 'No projects yet. Create one above.' : 'No projects yet. Ask an admin to add you to one.'}</p>
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
            {showArchived && <>
              <h3 className="muted">Archived ({archived.length})</h3>
              {archived.length === 0 ? <p className="muted">No archived projects.</p> : <ProjectList projects={archived} onRestore={restore} />}
            </>}
          </>
        )}
      </main>
    </div>
  )
}

function ProjectList({ projects, onRestore }: { projects: Project[]; onRestore?: (p: Project) => void }) {
  return (
    <ul className="list">
      {projects.map(p => (
        <li key={p.id} className={p.archived ? 'archived-item' : undefined}>
          <Link to={`/projects/${p.id}`} className="list-item">
            <span className="list-title">{p.name}{p.archived && <span className="archived-badge">Archived</span>}</span>
            <span className="muted">{p.document_count} plan{p.document_count === 1 ? '' : 's'} · {p.role}</span>
          </Link>
          {p.archived && onRestore && <button type="button" onClick={() => onRestore(p)}>Restore</button>}
        </li>
      ))}
    </ul>
  )
}
