import { HARDWARE_FIELDS, STATUSES } from './types'
import { useState } from 'react'
import { Attribution, HistorySection } from './MarkupInfo'
import { DevicePhotos } from '../photos/DevicePhotos'
import { BarcodeScanner } from '../photos/BarcodeScanner'
import '../photos/photos.css'
import type { FieldDef, Markup, Status, SymbolSet } from './types'

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export const isValidIp = (v: string) => !v || IPV4.test(v.trim())

interface Props {
  devices: Markup[]
  set?: SymbolSet
  readOnly: boolean
  onUpdate: (patch: (m: Markup) => Markup, mergeKey: string) => void
  /** Computed area names (outermost first) for a single device; omitted for multi-select. */
  areaPath?: string[]
  /** Heading for multi-device mode (default "N devices"), e.g. "Stack of 6". */
  heading?: string
}

/** Device data entry: tag, install status, hardware fields and the symbol set's own fields. */
export function DeviceFields({ devices, set, readOnly, onUpdate, areaPath, heading }: Props) {
  const d = devices[0]
  const single = devices.length === 1
  const setStatus = (status: Status) => onUpdate(m => ({ ...m, status }), 'status')
  const setField = (key: string, value: string | number | boolean) =>
    onUpdate(m => ({ ...m, fields: { ...m.fields, [key]: value } }), `field.${key}.${single ? d.id : 'all'}`)
  /** Multi-device: the shared value when every device agrees, otherwise empty + "Mixed". */
  const shared = (key: string) => {
    const vals = devices.map(m => m.fields?.[key] ?? '')
    return { value: d.fields?.[key], mixed: vals.some(v => v !== vals[0]) }
  }
  const [scanKey, setScanKey] = useState<string | null>(null)
  const scanProps = (key: string) => (key === 'serial' || key === 'mac') && !readOnly ? { onScan: () => setScanKey(key) } : {}
  const onScanned = (text: string) => {
    if (!scanKey) return
    const t = text.trim()
    const hex = t.replace(/[^0-9a-fA-F]/g, '')
    const value = scanKey === 'mac' && /^([0-9a-fA-F]{2}[:\-.]?){5}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{12}$/.test(t) && hex.length === 12
      ? hex.toUpperCase().match(/../g)!.join(':') : t
    setField(scanKey, value)
    setScanKey(null)
  }
  const fov = 'width' in d.geometry ? d.geometry.fov : undefined

  return (
    <>
    <fieldset disabled={readOnly} className="stack">
      <div className="device-head">
        <span className="set-icon" style={{ background: set?.color ?? '#868e96' }}>{set?.icon && <img src={set.icon} alt="" />}</span>
        <div>
          <div className="panel-heading">{single ? d.tag || 'New device' : heading ?? `${devices.length} devices`}</div>
          <div className="muted small">{set?.name ?? 'Unknown set'}</div>
          {single && <Attribution markup={d} />}
          {single && areaPath && areaPath.length > 0 && (
            <div className="area-path small" title="Area">{'📍'} {areaPath.join(' › ')}</div>
          )}
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
          {set?.fields.map(f => <FieldInput key={f.key} def={f} value={d.fields?.[f.key]} onChange={v => setField(f.key, v)} {...scanProps(f.key)} />)}
          <div className="muted small section-label">Hardware</div>
          {HARDWARE_FIELDS.map(f => <FieldInput key={f.key} def={f} value={d.fields?.[f.key]} onChange={v => setField(f.key, v)} {...scanProps(f.key)} />)}
          <label className="field">Notes
            <textarea rows={2} value={String(d.fields?.notes ?? '')} onChange={e => setField('notes', e.target.value)} />
          </label>
          {set?.has_fov && fov && (
            <>
              <div className="muted small section-label">Coverage cone{fov.hidden ? '' : ' · drag the white dot to aim'}</div>
              <label className="check"><input type="checkbox" checked={!fov.hidden}
                onChange={e => onUpdate(m => ({ ...m, geometry: { ...m.geometry, fov: { ...fov, hidden: !e.target.checked } } }), `fovshow.${d.id}`)} /> Show coverage cone</label>
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
      {!single && set?.fields.map(f => {
        const sh = shared(f.key)
        return <FieldInput key={f.key} def={f} value={sh.mixed ? undefined : sh.value} mixed={sh.mixed} onChange={v => setField(f.key, v)} />
      })}
      {scanKey && <BarcodeScanner onResult={onScanned} onClose={() => setScanKey(null)} />}
    </fieldset>
    {/* Outside the disabled fieldset so viewers can still open and browse photos */}
    {single && (
      <div className="stack">
        <div className="muted small section-label">Photos</div>
        <DevicePhotos markupId={d.id} readOnly={readOnly} />
      </div>
    )}
    {single && <HistorySection markup={d} set={set} />}
    </>
  )
}

function FieldInput({ def, value, onChange, onScan, mixed }: { def: FieldDef; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void; onScan?: () => void; mixed?: boolean }) {
  if (def.type === 'checkbox') {
    return <label className="check"><input type="checkbox" checked={!!value} ref={el => { if (el) el.indeterminate = !!mixed }} onChange={e => onChange(e.target.checked)} /> {def.label}{mixed ? ' (Mixed)' : ''}</label>
  }
  if (def.type === 'select') {
    return (
      <label className="field">{def.label}
        <select value={String(value ?? '')} onChange={e => onChange(e.target.value)}>
          <option value="">{mixed ? 'Mixed' : '—'}</option>
          {(def.options ?? []).map(o => <option key={o}>{o}</option>)}
        </select>
      </label>
    )
  }
  const v = String(value ?? '')
  const bad = def.type === 'ip' && !isValidIp(v)
  return (
    <label className="field">{def.label}
      <span className="input-row">
      <input className={bad ? 'invalid' : ''} value={v}
        type={def.type === 'date' ? 'date' : 'text'}
        inputMode={def.type === 'number' ? 'numeric' : def.type === 'ip' ? 'decimal' : undefined}
        placeholder={mixed ? 'Mixed' : def.type === 'ip' ? '192.168.1.10' : undefined}
        onChange={e => onChange(def.type === 'number' && e.target.value !== '' && !isNaN(+e.target.value) ? +e.target.value : e.target.value)} />
      {onScan && <button type="button" className="scan-btn" onClick={onScan} aria-label={`Scan ${def.label}`} title="Scan barcode">Scan</button>}
      </span>
      {bad && <span className="hint-bad">Not a valid IPv4 address</span>}
    </label>
  )
}
