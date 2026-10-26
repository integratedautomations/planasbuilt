import { HARDWARE_FIELDS } from '../markups/types'
import { Icon } from '../ui/Icon'
import type { SymbolSet } from '../markups/types'
import { REPORT_SECTIONS, TAG_FORMAT_LABELS } from '../projectSettings'
import type { ProjectRules, StatusDef, TagFormat } from '../projectSettings'

/** What a status can require: a photo, a tag, the hardware fields and every symbol set's own fields. */
export function requirableItems(sets: SymbolSet[]): { key: string; label: string }[] {
  const out = [{ key: 'photo', label: 'Photo' }, { key: 'tag', label: 'Tag' }, ...HARDWARE_FIELDS.map(f => ({ key: f.key, label: f.label }))]
  const seen = new Set(out.map(o => o.key))
  for (const s of sets) for (const f of s.fields ?? []) if (!seen.has(f.key)) { seen.add(f.key); out.push({ key: f.key, label: f.label }) }
  return out
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)

interface Props {
  value: ProjectRules
  onChange: (next: ProjectRules) => void
  sets: SymbolSet[]
  /** Status keys that devices use right now: they cannot be removed. */
  inUse?: Set<string>
  disabled?: boolean
  /** Which cards to show (default: all). Project Settings shows them one section at a time. */
  parts?: RulesPart[]
}
export type RulesPart = 'statuses' | 'required' | 'tags' | 'report' | 'photos' | 'cables'

/** Status workflow, required fields, tags, report sections and photo quality. Shared by the project and the organization defaults. */
export function ProjectRulesForm({ value, onChange, sets, inUse, disabled, parts }: Props) {
  const v = value
  const show = (p: RulesPart) => !parts || parts.includes(p)
  const set = (p: Partial<ProjectRules>) => onChange({ ...v, ...p })
  const setStatus = (i: number, p: Partial<StatusDef>) => set({ statuses: v.statuses.map((s, j) => (j === i ? { ...s, ...p } : s)) })
  const move = (i: number, d: -1 | 1) => {
    const next = [...v.statuses]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    set({ statuses: next })
  }
  const remove = (i: number) => {
    const key = v.statuses[i].key
    const required = { ...v.required }
    delete required[key]
    set({ statuses: v.statuses.filter((_, j) => j !== i), required })
  }
  const add = () => {
    let n = v.statuses.length + 1, key = `status-${n}`
    while (v.statuses.some(s => s.key === key)) key = `status-${++n}`
    set({ statuses: [...v.statuses, { key, label: '', color: '#7048e8' }] })
  }
  const items = requirableItems(sets)
  const toggleReq = (status: string, key: string, on: boolean) => {
    const cur = v.required[status] ?? []
    const next = on ? [...cur, key] : cur.filter(k => k !== key)
    const required = { ...v.required, [status]: next }
    if (!next.length) delete required[status]
    set({ required })
  }

  return (
    <fieldset className="rules-form" disabled={disabled}>
      {show('statuses') && (
      <section className="card settings-card">
        <h3><Icon name="rules" size={18} /> Status workflow</h3>
        <p className="muted small">The statuses a device can have, in the order they are listed. Statuses devices use now cannot be removed.</p>
        <ul className="status-editor">
          {v.statuses.map((s, i) => {
            const used = inUse?.has(s.key)
            return (
              <li key={i} className="row">
                <input type="color" aria-label={`Color of ${s.label || s.key}`} value={s.color} onChange={e => setStatus(i, { color: e.target.value })} />
                <input className="status-name" aria-label="Status name" value={s.label} maxLength={30} placeholder="Name" onChange={e => {
                  // A new (unsaved) status takes its key from its name until it is saved.
                  const isNew = /^status-\d+$/.test(s.key)
                  const key = isNew ? slug(e.target.value) || s.key : s.key
                  const clash = isNew && v.statuses.some((o, j) => j !== i && o.key === key)
                  const nk = clash ? s.key : key
                  const required = { ...v.required }
                  if (nk !== s.key && required[s.key]) { required[nk] = required[s.key]; delete required[s.key] }
                  set({ statuses: v.statuses.map((o, j) => (j === i ? { ...o, label: e.target.value, key: nk } : o)), required })
                }} />
                <code className="muted small status-key" title="Stored on each device">{s.key}</code>
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>^</button>
                <button type="button" aria-label="Move down" disabled={i === v.statuses.length - 1} onClick={() => move(i, 1)}>v</button>
                <button type="button" className="danger" disabled={v.statuses.length <= 1 || !!used} title={used ? 'Devices use this status' : 'Remove'} onClick={() => remove(i)}>Remove</button>
              </li>
            )
          })}
        </ul>
        <div className="row"><button type="button" disabled={v.statuses.length >= 12} onClick={add}>Add status</button></div>
      </section>
      )}

      {show('required') && (
      <section className="card settings-card">
        <h3><Icon name="lock" size={18} /> Required before a status</h3>
        <p className="muted small">A device cannot be given a status until it has what is ticked. Items a device does not have (for example IP on a smoke detector) are not asked for. Devices already in that status can still be edited.</p>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead><tr><th>Needs</th>{v.statuses.map(s => <th key={s.key}>{s.label || s.key}</th>)}</tr></thead>
            <tbody>
              {items.map(it => (
                <tr key={it.key}>
                  <th scope="row">{it.label}</th>
                  {v.statuses.map(s => (
                    <td key={s.key}>
                      <input type="checkbox" aria-label={`${s.label || s.key} needs ${it.label}`} checked={(v.required[s.key] ?? []).includes(it.key)}
                        onChange={e => toggleReq(s.key, it.key, e.target.checked)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {show('cables') && !parts && (
      <section className="card settings-card">
        <h3><Icon name="cable" size={18} /> Cables</h3>
        <label className="check"><input type="checkbox" checked={v.cable_via_drop} onChange={e => set({ cable_via_drop: e.target.checked })} /> Add drop length at devices a cable passes through</label>
        <label className="field">Measure cables as
          <select value={v.cable_mode} onChange={e => set({ cable_mode: e.target.value === 'home' ? 'home' : 'daisy' })}>
            <option value="daisy">Daisy chain (drawn path once)</option>
            <option value="home">Home runs (a cable per device from the start)</option>
          </select>
        </label>
        <p className="muted small">When a cable run is clicked through devices, each one counts like an end for the drop length (slack and drop are set per project under Cable defaults).</p>
      </section>
      )}

      {show('tags') && (
      <section className="card settings-card">
        <h3><Icon name="tag" size={18} /> Tags</h3>
        <label className="field">Tag format
          <select value={v.tag_format} onChange={e => set({ tag_format: e.target.value as TagFormat })}>
            {(Object.keys(TAG_FORMAT_LABELS) as TagFormat[]).map(k => <option key={k} value={k}>{TAG_FORMAT_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={v.tag_fill_gaps} onChange={e => set({ tag_fill_gaps: e.target.checked })} /> Fill numbering gaps (otherwise continue from the highest)</label>
        <div className="small muted">Tag prefix per symbol set (blank = the set's own)</div>
        <div className="prefix-grid">
          {sets.map(s => (
            <label key={s.id} className="field inline">{s.name}
              <input value={v.tag_prefixes[s.id.toLowerCase()] ?? ''} maxLength={12} placeholder={s.tag_prefix}
                onChange={e => {
                  const next = { ...v.tag_prefixes }
                  const val = e.target.value.replace(/[^A-Za-z0-9_]/g, '').toUpperCase()
                  if (val) next[s.id.toLowerCase()] = val; else delete next[s.id.toLowerCase()]
                  set({ tag_prefixes: next })
                }} />
            </label>
          ))}
        </div>
        <p className="muted small">Applies to tags created from now on; existing tags are not renamed. A device type with its own prefix keeps it.</p>
      </section>
      )}

      {show('report') && (
      <section className="card settings-card">
        <h3><Icon name="file" size={18} /> Report sections</h3>
        <p className="muted small">Sections switched off here are left out of every as-built report for this project.</p>
        {REPORT_SECTIONS.map(r => (
          <label key={r.key} className="check">
            <input type="checkbox" checked={v.report.sections[r.key]} onChange={e => set({ report: { ...v.report, sections: { ...v.report.sections, [r.key]: e.target.checked } } })} /> {r.label}
          </label>
        ))}
      </section>
      )}

      {show('photos') && (
      <section className="card settings-card">
        <h3><Icon name="camera" size={18} /> Photos</h3>
        <label className="field">Compression quality: {Math.round(v.photo_quality * 100)}%
          <input type="range" min={30} max={95} step={5} value={Math.round(v.photo_quality * 100)} onChange={e => set({ photo_quality: Number(e.target.value) / 100 })} />
        </label>
        <p className="muted small">Photos are shrunk on the phone before upload. Lower is smaller and faster; 80% is a good balance. To make a photo mandatory, tick Photo under a status above.</p>
      </section>
      )}
    </fieldset>
  )
}
