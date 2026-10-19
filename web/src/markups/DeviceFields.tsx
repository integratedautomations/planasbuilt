import { HARDWARE_FIELDS, STATUSES } from './types'
import type { FieldDef, Markup, Status, SymbolSet } from './types'

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export const isValidIp = (v: string) => !v || IPV4.test(v.trim())

interface Props {
  devices: Markup[]
  set?: SymbolSet
  readOnly: boolean
  onUpdate: (patch: (m: Markup) => Markup, mergeKey: string) => void
}

/** Device data entry: tag, install status, hardware fields and the symbol set's own fields. */
export function DeviceFields({ devices, set, readOnly, onUpdate }: Props) {
  const d = devices[0]
  const single = devices.length === 1
  const setStatus = (status: Status) => onUpdate(m => ({ ...m, status }), 'status')
  const setField = (key: string, value: string | number | boolean) =>
    onUpdate(m => ({ ...m, fields: { ...m.fields, [key]: value } }), `field.${key}.${d.id}`)
  const fov = 'width' in d.geometry ? d.geometry.fov : undefined

  return (
    <fieldset disabled={readOnly} className="stack">
      <div className="device-head">
        <span className="set-icon" style={{ background: set?.color ?? '#868e96' }}>{set?.icon && <img src={set.icon} alt="" />}</span>
        <div>
          <div className="panel-heading">{single ? d.tag || 'New device' : `${devices.length} devices`}</div>
          <div className="muted small">{set?.name ?? 'Unknown set'}</div>
        </div>
      </div>

      <div className="field">Status
        <div className="status-buttons">
          {STATUSES.map(s => (
            <button key={s.value} className={devices.every(m => m.status === s.value) ? 'on' : ''}
              style={{ '--status': s.color } as React.CSSProperties} onClick={() => setStatus(s.value)}>
              <span className="dot" style={{ background: s.color }} />{s.label}
            </button>
          ))}
        </div>
      </div>

      {single && (
        <>
          <label className="field">Tag
            <input value={d.tag ?? ''} onChange={e => onUpdate(m => ({ ...m, tag: e.target.value }), `tag.${d.id}`)} />
          </label>
          {set?.fields.map(f => <FieldInput key={f.key} def={f} value={d.fields?.[f.key]} onChange={v => setField(f.key, v)} />)}
          <div className="muted small section-label">Hardware</div>
          {HARDWARE_FIELDS.map(f => <FieldInput key={f.key} def={f} value={d.fields?.[f.key]} onChange={v => setField(f.key, v)} />)}
          <label className="field">Notes
            <textarea rows={2} value={String(d.fields?.notes ?? '')} onChange={e => setField('notes', e.target.value)} />
          </label>
          {set?.has_fov && fov && (
            <>
              <div className="muted small section-label">Coverage cone · drag the white dot to aim</div>
              <label className="field">Angle <span className="muted">{fov.angle}°</span>
                <input type="range" min={10} max={360} step={5} value={fov.angle}
                  onChange={e => onUpdate(m => ({ ...m, geometry: { ...m.geometry, fov: { ...fov, angle: +e.target.value } } }), `fov.${d.id}`)} />
              </label>
              <label className="field">Range <span className="muted">{Math.round(fov.range)}</span>
                <input type="range" min={10} max={1500} step={5} value={fov.range}
                  onChange={e => onUpdate(m => ({ ...m, geometry: { ...m.geometry, fov: { ...fov, range: +e.target.value } } }), `fov.${d.id}`)} />
              </label>
            </>
          )}
        </>
      )}
    </fieldset>
  )
}

function FieldInput({ def, value, onChange }: { def: FieldDef; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void }) {
  if (def.type === 'checkbox') {
    return <label className="check"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /> {def.label}</label>
  }
  if (def.type === 'select') {
    return (
      <label className="field">{def.label}
        <select value={String(value ?? '')} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          {(def.options ?? []).map(o => <option key={o}>{o}</option>)}
        </select>
      </label>
    )
  }
  const v = String(value ?? '')
  const bad = def.type === 'ip' && !isValidIp(v)
  return (
    <label className="field">{def.label}
      <input className={bad ? 'invalid' : ''} value={v}
        type={def.type === 'date' ? 'date' : 'text'}
        inputMode={def.type === 'number' ? 'numeric' : def.type === 'ip' ? 'decimal' : undefined}
        placeholder={def.type === 'ip' ? '192.168.1.10' : undefined}
        onChange={e => onChange(def.type === 'number' && e.target.value !== '' && !isNaN(+e.target.value) ? +e.target.value : e.target.value)} />
      {bad && <span className="hint-bad">Not a valid IPv4 address</span>}
    </label>
  )
}
