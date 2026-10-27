import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Project } from '../api'
import { forgetProjectLocal } from '../offline/cache'
import { Icon } from '../ui/Icon'
import { useConfirm } from '../ui/ConfirmDialog'
import { useTypedConfirm } from '../ui/TypedConfirm'

/** Company owners and admins: archive or restore this project, or delete it permanently (its files go to the trash). */
export function DangerZonePanel({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const navigate = useNavigate()
  const { ask, dialog } = useConfirm()
  const typed = useTypedConfirm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const archived = !!project.archived

  async function setArchived(next: boolean) {
    const ok = await ask(next
      ? `Archive "${project.name}"? It disappears from the project list and becomes read-only for everyone until you restore it.`
      : `Restore "${project.name}"? It returns to the project list and can be edited again.`, next ? 'Archive' : 'Restore')
    if (!ok) return
    setError(''); setBusy(true)
    try {
      const p = await api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ archived: next }) })
      onProject({ ...project, archived: p.archived, archived_at: p.archived_at })
      if (next) await forgetProjectLocal(project.id, true)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function remove() {
    const ok = await typed.ask({
      title: 'Delete project permanently',
      message: `This deletes "${project.name}" with all its plans, markups, photos and members. Its files move to the trash and are purged after the retention period. This cannot be undone.`,
      expected: [project.name], confirmLabel: 'Delete project',
    })
    if (!ok) return
    setError(''); setBusy(true)
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE', body: JSON.stringify({ name: project.name }) })
      await forgetProjectLocal(project.id)
      navigate('/')
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  return (
    <section className="card settings-card danger-zone">
      <h3><Icon name="trash" size={18} /> Danger zone</h3>
      <div className="danger-row">
        <div>
          <strong>{archived ? 'Restore this project' : 'Archive this project'}</strong>
          <p className="muted small">{archived
            ? 'It is archived: hidden from the project list and read-only for everyone.'
            : 'Hides it from the project list and makes it read-only for everyone. Nothing is deleted; you can restore it at any time.'}</p>
        </div>
        <button disabled={busy} onClick={() => void setArchived(!archived)}>{archived ? 'Restore project' : 'Archive project'}</button>
      </div>
      <div className="danger-row">
        <div>
          <strong>Delete project permanently</strong>
          <p className="muted small">Removes the project and everything in it. Files go to the trash first and are purged by the retention schedule.</p>
        </div>
        <button className="danger" disabled={busy} onClick={() => void remove()}>Delete project permanently</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {dialog}{typed.dialog}
    </section>
  )
}
