import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Layer, SymbolSet } from '../markups/types'
import { ROLE_INFO, ROLES } from '../roles'
import type { Role, Scope } from '../roles'

/** The <option>s of a project-role dropdown, most access first. */
export function RoleOptions() {
  return <>{ROLES.map(r => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}</>
}

/** A project-role dropdown with the description of the chosen role underneath. */
export function RoleSelect({ value, onChange, label = 'Role', describe = true }: { value: Role; onChange: (r: Role) => void; label?: string; describe?: boolean }) {
  return (
    <span className="role-select">
      <select value={value} aria-label={label} onChange={e => onChange(e.target.value as Role)}><RoleOptions /></select>
      {describe && <span className="muted small role-desc">{ROLE_INFO[value].description}</span>}
    </span>
  )
}

/** Checklists of symbol sets and layers a subcontractor may see and work on. Nothing ticked = they see nothing. */
export function ScopePicker({ projectId, value, onChange }: { projectId: string; value: Scope; onChange: (s: Scope) => void }) {
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [layers, setLayers] = useState<Layer[]>([])
  useEffect(() => {
    api<SymbolSet[]>('/symbol-sets').then(setSets).catch(() => {})
    api<Layer[]>(`/projects/${projectId}/layers`).then(setLayers).catch(() => {})
  }, [projectId])
  const toggle = (key: keyof Scope, id: string) =>
    onChange({ ...value, [key]: value[key].includes(id) ? value[key].filter(x => x !== id) : [...value[key], id] })
  return (
    <div className="scope-picker stack">
      <div className="muted small">A subcontractor sees only markups in the symbol sets or layers ticked here. With nothing ticked they see nothing.</div>
      <div className="small section-label muted">Symbol sets</div>
      <div className="scope-list">
        {sets.map(s => <label key={s.id} className="check"><input type="checkbox" checked={value.sets.includes(s.id)} onChange={() => toggle('sets', s.id)} /> {s.name}</label>)}
        {!sets.length && <span className="muted small">None</span>}
      </div>
      <div className="small section-label muted">Layers</div>
      <div className="scope-list">
        {layers.map(l => <label key={l.id} className="check"><input type="checkbox" checked={value.layers.includes(l.id)} onChange={() => toggle('layers', l.id)} /> {l.name}</label>)}
        {!layers.length && <span className="muted small">None in this project</span>}
      </div>
    </div>
  )
}
