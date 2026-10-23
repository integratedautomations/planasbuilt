import type { FieldDef, FieldType } from '../markups/types'

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'select', label: 'Dropdown' },
  { value: 'ip', label: 'IP address' }, { value: 'date', label: 'Date' }, { value: 'checkbox', label: 'Checkbox' },
]

/** Editor for a list of field definitions; shared by symbol sets and device types. */
export function FieldsEditor({ fields, onChange }: { fields: FieldDef[]; onChange: (fields: FieldDef[]) => void }) {
  const setField = (i: number, patch: Partial<FieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const moveField = (i: number, dir: -1 | 1) => {
    const next = fields.slice()
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <div className="stack">
      {fields.map((f, i) => (
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
          <label className="check nowrap" title="Clients never see internal fields or their values">
            <input type="checkbox" checked={!!f.internal} onChange={e => setField(i, { internal: e.target.checked || undefined })} /> Internal
          </label>
          <span className="row nowrap">
            <button className="icon-btn small" title="Move up" onClick={() => moveField(i, -1)}>↑</button>
            <button className="icon-btn small" title="Move down" onClick={() => moveField(i, 1)}>↓</button>
            <button className="icon-btn small danger" title="Remove" onClick={() => onChange(fields.filter((_, j) => j !== i))}>✕</button>
          </span>
        </div>
      ))}
      <button onClick={() => onChange([...fields, { key: '', label: '', type: 'text' }])}>+ Add field</button>
    </div>
  )
}
