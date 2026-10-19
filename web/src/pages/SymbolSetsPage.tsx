import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post } from '../api'
import type { User } from '../api'
import type { FieldDef, FieldType, SymbolSet } from '../markups/types'
import { HARDWARE_FIELDS } from '../markups/types'

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'select', label: 'Dropdown' },
  { value: 'ip', label: 'IP address' }, { value: 'date', label: 'Date' }, { value: 'checkbox', label: 'Checkbox' },
]

type Draft = Omit<SymbolSet, 'id' | 'sort'> & { id?: string }
const EMPTY: Draft = { name: '', color: '#1971c2', tag_prefix: '', icon: '', fields: [], has_fov: false }

/** Reads an uploaded icon as a data URL; raster images are shrunk to 128px so they stay small. */
async function readIcon(file: File): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  if (file.type === 'image/svg+xml') return url
  const img = new Image()
  img.src = url
  await img.decode()
  const scale = Math.min(1, 128 / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale)
  c.height = Math.round(img.height * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

export function SymbolSetsPage({ user }: { user: User }) {
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { api<SymbolSet[]>('/symbol-sets').then(setSets).catch(e => setError(e.message)) }, [])

  async function save() {
    if (!draft) return
    setError('')
    try {
      const saved = draft.id
        ? await api<SymbolSet>(`/symbol-sets/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) })
        : await post<SymbolSet>('/symbol-sets', draft)
      setSets(ss => draft.id ? ss.map(s => (s.id === saved.id ? saved : s)) : [...ss, saved])
      setDraft(null)
    } catch (e) { setError((e as Error).message) }
  }

  async function archive(s: SymbolSet) {
    if (!confirm(`Remove "${s.name}" from the palette? Devices already placed keep their data.`)) return
    await api(`/symbol-sets/${s.id}`, { method: 'DELETE' })
    setSets(ss => ss.filter(x => x.id !== s.id))
    setDraft(null)
  }

  const setField = (i: number, patch: Partial<FieldDef>) =>
    setDraft(d => d && { ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) })
  const moveField = (i: number, dir: -1 | 1) => setDraft(d => {
    if (!d) return d
    const fields = d.fields.slice()
    const j = i + dir
    if (j < 0 || j >= fields.length) return d
    ;[fields[i], fields[j]] = [fields[j], fields[i]]
    return { ...d, fields }
  })

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">PlanAsBuilt</Link>
        <span className="muted">/</span>
        <span className="crumb">Symbol sets</span>
      </header>
      <main className="content">
        {!user.is_admin && <p className="muted">Only admins can edit symbol sets.</p>}
        <div className="row">
          <h2>Symbol sets</h2>
          <span className="spacer" />
          {user.is_admin && <button className="primary" onClick={() => setDraft({ ...EMPTY })}>New set</button>}
        </div>
        {error && <div className="error">{error}</div>}
        <ul className="list">
          {sets.map(s => (
            <li key={s.id}>
              <button className="list-item set-item" disabled={!user.is_admin}
                onClick={() => setDraft({ ...s, fields: s.fields.map(f => ({ ...f })) })}>
                <span className="set-icon" style={{ background: s.color }}>{s.icon && <img src={s.icon} alt="" />}</span>
                <span className="grow">
                  <span className="list-title">{s.name}</span>
                  <span className="muted"> · {s.tag_prefix}-01 · {s.fields.length} fields{s.has_fov ? ' · coverage cone' : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </main>

      {draft && (
        <div className="modal-backdrop" onClick={() => setDraft(null)}>
          <div className="card modal wide" onClick={e => e.stopPropagation()}>
            <div className="row"><h3>{draft.id ? 'Edit symbol set' : 'New symbol set'}</h3><span className="spacer" />
              <button onClick={() => setDraft(null)}>Close</button></div>
            <div className="grid2">
              <label className="field">Name<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
              <label className="field">Tag prefix
                <input value={draft.tag_prefix} placeholder="CAM"
                  onChange={e => setDraft({ ...draft, tag_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
              </label>
              <label className="field">Category color
                <input type="color" value={draft.color} onChange={e => setDraft({ ...draft, color: e.target.value })} />
              </label>
              <label className="field">Icon (SVG or PNG)
                <span className="row">
                  <span className="set-icon" style={{ background: draft.color }}>{draft.icon && <img src={draft.icon} alt="" />}</span>
                  <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp"
                    onChange={async e => { const f = e.target.files?.[0]; if (f) setDraft({ ...draft, icon: await readIcon(f) }) }} />
                </span>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={draft.has_fov}
              onChange={e => setDraft({ ...draft, has_fov: e.target.checked })} /> Show coverage cone (cameras, motion sensors)</label>

            <h4>Fields</h4>
            <p className="muted small">Every device also has: {HARDWARE_FIELDS.map(f => f.label).join(', ')}, and install status.</p>
            <div className="stack">
              {draft.fields.map((f, i) => (
                <div key={i} className="field-row">
                  <input placeholder="Label" value={f.label} onChange={e => setField(i, { label: e.target.value })} />
                  <select value={f.type} onChange={e => setField(i, { type: e.target.value as FieldType })}>
                    {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  {f.type === 'select' && (
                    <input className="options" placeholder="Options, comma separated" value={(f.options ?? []).join(', ')}
                      onChange={e => setField(i, { options: e.target.value.split(',').map(s => s.trimStart()) })}
                      onBlur={e => setField(i, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
                  )}
                  <span className="row nowrap">
                    <button className="icon-btn small" title="Move up" onClick={() => moveField(i, -1)}>↑</button>
                    <button className="icon-btn small" title="Move down" onClick={() => moveField(i, 1)}>↓</button>
                    <button className="icon-btn small danger" title="Remove"
                      onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}>✕</button>
                  </span>
                </div>
              ))}
              <button onClick={() => setDraft({ ...draft, fields: [...draft.fields, { key: '', label: '', type: 'text' }] })}>+ Add field</button>
            </div>
            {error && <div className="error">{error}</div>}
            <div className="row">
              {draft.id && <button className="danger" onClick={() => archive(draft as SymbolSet)}>Remove set</button>}
              <span className="spacer" />
              <button className="primary" onClick={save} disabled={!draft.name.trim() || !draft.tag_prefix}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
