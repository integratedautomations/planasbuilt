import { useRef } from 'react'
import { NavLink, useSearchParams } from 'react-router-dom'
import { Icon } from '../ui/Icon'
import type { User } from '../api'
import { can } from '../roles'
import { PROJECT_SECTIONS, ProjectSettingsTab } from '../settings/ProjectSettingsTab'
import type { ProjectSection } from '../settings/ProjectSettingsTab'
import { ProjectBody, useProject } from '../shell/ProjectShell'
import { useActiveTabIntoView } from '../ui/useActiveTabIntoView'

/** Settings tab of a project: General, Rules, Tags, Cable defaults, Report, and (platform admins) Move to another company. */
export function ProjectSettingsPage({ user }: { user: User }) {
  const { project, setProject } = useProject()
  const [params] = useSearchParams()
  const tabsRef = useRef<HTMLElement>(null)
  useActiveTabIntoView(tabsRef, params.get('section'))
  if (!project) return <p className="muted">Loading…</p>
  const manage = can(project.role, 'members.manage')
  if (!manage && !user.platform_admin) return <ProjectBody><p className="muted">Only project admins can change settings.</p></ProjectBody>
  const sections = PROJECT_SECTIONS.filter(s => !s.platform || user.platform_admin)
  const visible = manage ? sections : sections.filter(s => s.platform)
  const section = (visible.find(s => s.id === params.get('section'))?.id ?? visible[0].id) as ProjectSection
  return (
    <ProjectBody width="wide">
      <nav className="tabs sub-tabs" aria-label="Settings sections" ref={tabsRef}>
        {visible.map(s => (
          <NavLink key={s.id} to={`?section=${s.id}`} replace className={() => `tab${section === s.id ? ' active' : ''}`}><Icon name={s.icon} size={16} /> {s.label}</NavLink>
        ))}
      </nav>
      <ProjectSettingsTab project={project} onProject={setProject} section={section} platformAdmin={!!user.platform_admin} />
    </ProjectBody>
  )
}
