import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import { api } from '../api'
import type { Project, User } from '../api'
import { loadProject } from '../offline/cache'
import { Icon } from '../ui/Icon'
import { lockedFor } from '../projectSettings'
import { can } from '../roles'
import { useActiveTabIntoView } from '../ui/useActiveTabIntoView'
import { PageShell } from './PageShell'
import { projectTabs } from './projectTabs'

interface ProjectCtx { project: Project | null; setProject: (p: Project) => void; user: User; error: string }
const Ctx = createContext<ProjectCtx | null>(null)
export const useProject = () => { const c = useContext(Ctx); if (!c) throw new Error('useProject outside ProjectShell'); return c }

/** The tab strip: real links, so the browser's back button, reload and deep links all land on the same tab. */
export function ProjectTabs({ projectId, canManage, platformAdmin, canSeeCosts }: { projectId: string; canManage: boolean; platformAdmin?: boolean; canSeeCosts?: boolean }) {
  const tabs = projectTabs(projectId, { canManage, platformAdmin, canSeeCosts })
  const ref = useRef<HTMLElement>(null)
  useActiveTabIntoView(ref, useLocation().pathname)
  return (
    <nav className="tabs" aria-label="Project" ref={ref}>
      {tabs.map(t => (
        <NavLink key={t.id} to={t.to} end={t.end} className={({ isActive }) => `tab${isActive ? ' active' : ''}`} aria-current={undefined}>{t.label}</NavLink>
      ))}
    </nav>
  )
}

/** Layout route for every project page: same header, project name, Mark complete and tab strip on each, content width set by the page. */
export function ProjectShell({ user }: { user: User }) {
  const { projectId } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setProject(null); setError('')
    loadProject(projectId!).then(r => setProject(r.data)).catch(e => setError(e.message))
  }, [projectId])

  const locked = lockedFor(project?.role, { locked: project?.settings?.locked === true })
  const canEdit = can(project?.role, 'plans.edit') && !locked
  const canManage = can(project?.role, 'members.manage')
  const ctx = useMemo(() => ({ project, setProject: (p: Project) => setProject(p), user, error }), [project, user, error])

  const toggleComplete = useCallback(async () => {
    if (!project) return
    try {
      const p = await api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ status: project.status === 'completed' ? 'open' : 'completed' }) })
      setProject({ ...project, status: p.status, completed_at: p.completed_at })
    } catch (err) { setError((err as Error).message) }
  }, [project])

  const actions = (
    <>
      {project?.status === 'completed' && <span className="muted small hide-narrow">Completed</span>}
      {canEdit && project && (
        <button className="pp-complete" onClick={toggleComplete}
          aria-label={project.status === 'completed' ? 'Reopen project' : 'Mark project complete'} title={project.status === 'completed' ? 'Reopen project' : 'Mark project complete'}>
          {project.status === 'completed'
            ? <><span className="hide-narrow">Reopen project</span><span className="show-narrow"><Icon name="undo" size={16} /></span></>
            : <><span className="hide-narrow">Mark complete</span><span className="show-narrow"><Icon name="check" size={16} /></span></>}
        </button>
      )}
    </>
  )
  return (
    <Ctx.Provider value={ctx}>
      <PageShell crumbs={[{ label: 'Projects', to: '/' }, { label: project?.name ?? '…' }]} actions={actions} width="full" className="project-content"
        below={<div className="project-tabs-bar"><ProjectTabs projectId={projectId!} canManage={canManage} platformAdmin={user.platform_admin} canSeeCosts={project?.can_see_costs} /></div>}>
        {locked && <div className="lock-banner" role="status">This project is locked. Only admins can make changes.</div>}
        {error && !project && <div className="error">{error}</div>}
        <Outlet />
      </PageShell>
    </Ctx.Provider>
  )
}

/** Width wrapper each project page picks: default 860, wide 1100, full = tables that scroll in their own container. */
export function ProjectBody({ width = 'default', children }: { width?: 'default' | 'wide' | 'full'; children: React.ReactNode }) {
  return <div className={`project-body pb-${width}`}>{children}</div>
}
