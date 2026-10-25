import type { User } from '../api'
import { can } from '../roles'
import { MembersPanel } from '../settings/MembersPanel'
import { ProjectBody, useProject } from '../shell/ProjectShell'

/** Members tab of a project. */
export function ProjectMembersPage({ user }: { user: User }) {
  const { project } = useProject()
  if (!project) return <p className="muted">Loading…</p>
  return <ProjectBody><MembersPanel projectId={project.id} canManage={can(project.role, 'members.manage')} me={user} /></ProjectBody>
}
