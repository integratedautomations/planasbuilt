import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import { api } from '../api'
import type { Markup, SymbolSet } from '../markups/types'
import type { Project } from '../api'
import { loadSymbolSets } from '../offline/cache'
import { applyProjectSettings, normalizeSettings } from '../projectSettings'
import type { ProjectRules } from '../projectSettings'
import { useAuthedUrl } from '../useAuthedUrl'
import { CableDefaults } from './CableDefaults'
import { MoveProjectPanel } from './MoveProjectPanel'
import { ProjectRulesForm } from './ProjectRulesForm'
import type { RulesPart } from './ProjectRulesForm'

export type ProjectSection = 'general' | 'rules' | 'tags' | 'cables' | 'report' | 'move'
export const PROJECT_SECTIONS: { id: ProjectSection; label: string; icon: IconName; platform?: boolean }[] = [
  { id: 'general', icon: 'settings', label: 'General' },
  { id: 'rules', icon: 'rules', label: 'Rules' },
  { id: 'tags', icon: 'tag', label: 'Tags' },
  { id: 'cables', icon: 'cable', label: 'Cable defaults' },
  { id: 'report', icon: 'file', label: 'Report' },
  { id: 'move', icon: 'move', label: 'Move to another company', platform: true },
]

const rulesOf = (p: Project): ProjectRules => {
  const s = normalizeSettings(p.settings)
  return { statuses: s.statuses, required: s.required, tag_prefixes: s.tag_prefixes, tag_format: s.tag_format, tag_fill_gaps: s.tag_fill_gaps, report: { sections: s.report.sections }, photo_quality: s.photo_quality }
}

const PARTS: Partial<Record<ProjectSection, RulesPart[]>> = { rules: ['statuses', 'required'], tags: ['tags'], report: ['report', 'photos'] }

/** One section of a project's Settings (project admins). Rules, Tags and Report share one draft; each shows its own Save bar. */
export function ProjectSettingsTab({ project, onProject, section = 'general', platformAdmin = false }: {
  project: Project; onProject: (p: Project) => void; section?: ProjectSection; platformAdmin?: boolean
}) {
  const settings = normalizeSettings(project.settings)
  const [rules, setRules] = useState<ProjectRules>(() => rulesOf(project))
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [inUse, setInUse] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [logoV, setLogoV] = useState(0)
  const file = useRef<HTMLInputElement>(null)
  const logoUrl = useAuthedUrl(settings.report.has_logo ? `/api/projects/${project.id}/logo?v=${logoV}` : undefined)

  useEffect(() => {
    loadSymbolSets().then(r => setSets([...r.data].sort((a, b) => a.sort - b.sort))).catch(() => {})
    api<Markup[]>(`/projects/${project.id}/markups`).then(ms => setInUse(new Set(ms.filter(m => m.status).map(m => m.status as string)))).catch(() => {})
  }, [project.id])
  useEffect(() => { setError(''); setMsg('') }, [section])

  const dirty = JSON.stringify(rules) !== JSON.stringify(rulesOf(project))

  /** Sends a partial settings update and adopts the answer. */
  async function send(patch: unknown) {
    setError(''); setMsg(''); setBusy(true)
    try {
      const next = await api<unknown>(`/projects/${project.id}/settings`, { method: 'PUT', body: JSON.stringify(patch) })
      applyProjectSettings(next)
      onProject({ ...project, settings: normalizeSettings(next) })
      return true
    } catch (e) { setError((e as Error).message); return false } finally { setBusy(false) }
  }
  async function save() {
    const bad = rules.statuses.findIndex(s => !s.label.trim())
    if (bad >= 0) { setError('Every status needs a name'); return }
    if (await send(rules)) setMsg('Saved')
  }
  async function setCosts(on: boolean) {
    setError('')
    try {
      const p = await api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ editors_see_costs: on }) })
      onProject({ ...project, editors_see_costs: p.editors_see_costs })
    } catch (e) { setError((e as Error).message) }
  }
  async function uploadLogo(f: File | undefined) {
    if (file.current) file.current.value = ''
    if (!f) return
    setError(''); setBusy(true)
    try {
      const form = new FormData()
      form.append('file', f)
      const next = await api<unknown>(`/projects/${project.id}/logo`, { method: 'POST', body: form })
      onProject({ ...project, settings: normalizeSettings(next) }); setLogoV(v => v + 1)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function removeLogo() {
    setError(''); setBusy(true)
    try {
      const next = await api<unknown>(`/projects/${project.id}/logo`, { method: 'DELETE' })
      onProject({ ...project, settings: normalizeSettings(next) })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const parts = PARTS[section]
  return (
    <div className="project-settings stack">
      {section === 'general' && (
        <section className="card settings-card">
          <h3><Icon name="settings" size={18} /> General</h3>
          <p className="muted small">Changes here apply as soon as you tick them.</p>
          <label className="check" title="Project managers and admins always see costs">
            <input type="checkbox" checked={project.editors_see_costs !== false} onChange={e => void setCosts(e.target.checked)} /> Editors see unit costs and labor hours
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.locked} disabled={busy}
              onChange={e => { if (!e.target.checked || confirm('Lock this project? Only admins will be able to edit it until you unlock it.')) void send({ locked: e.target.checked }) }} /> Lock project (only admins can edit)
          </label>
          <p className="muted small">Status names and required fields are under Rules; tag numbering under Tags.</p>
          {error && <div className="error" role="alert">{error}</div>}
        </section>
      )}

      {section === 'cables' && (
        <section className="card settings-card">
          <h3><Icon name="cable" size={18} /> Cable defaults</h3>
          <CableDefaults project={project} canEdit onSaved={onProject} />
        </section>
      )}

      {section === 'report' && (
        <section className="card settings-card">
          <h3><Icon name="file" size={18} /> Report logo</h3>
          <p className="muted small">Shown on the as-built report title page. Without one, the company logo is used. PNG or JPEG, 2 MB max. Uploading applies at once.</p>
          <div className="row">
            {settings.report.has_logo ? <img className="logo-preview" alt="Project logo" src={logoUrl || undefined} /> : <span className="muted small">Using the company logo</span>}
            <input ref={file} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" hidden onChange={e => void uploadLogo(e.target.files?.[0])} />
            <button type="button" disabled={busy} onClick={() => file.current?.click()}>{settings.report.has_logo ? 'Replace' : 'Upload'}</button>
            {settings.report.has_logo && <button type="button" className="danger" disabled={busy} onClick={() => void removeLogo()}>Remove</button>}
          </div>
        </section>
      )}

      {parts && <ProjectRulesForm value={rules} onChange={r => { setRules(r); setMsg('') }} sets={sets} inUse={inUse} disabled={busy} parts={parts} />}

      {section === 'move' && platformAdmin && <MoveProjectPanel project={project} />}

      {parts && (
        <div className="save-bar">
          {error && <div className="error" role="alert">{error}</div>}
          <div className="row">
            <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save changes'}</button>
            {dirty && <button type="button" disabled={busy} onClick={() => { setRules(rulesOf(project)); setError('') }}>Discard changes</button>}
            {msg && <span className="muted small" role="status">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
