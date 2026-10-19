import { useEffect, useRef, useState } from 'react'
import { parseFeetInches, SCALE_PRESETS } from './measure'

export interface PageScale { pointsPerFoot: number; label: string }

interface ControlProps {
  scale: PageScale | null
  readOnly: boolean
  onPreset: (s: PageScale) => void
  onCalibrate: () => void
  onApplyAll: () => void
  onClear: () => void
  busy: boolean
  error: string
}

/** Current sheet scale with preset picker, calibrate and apply-to-all actions. */
export function ScaleControl({ scale, readOnly, onPreset, onCalibrate, onApplyAll, onClear, busy, error }: ControlProps) {
  const presetValue = SCALE_PRESETS.find(p => p.label === scale?.label)?.label ?? ''
  return (
    <section className="scale-control">
      <div className="panel-heading">Scale</div>
      <div className={`scale-current${scale ? '' : ' warn'}`}>{scale ? scale.label : 'No scale'}</div>
      {!scale && <p className="muted small">Pick a preset or calibrate on a known dimension to measure on this sheet.</p>}
      <fieldset disabled={readOnly || busy} className="stack">
        <label className="field">Preset
          <select value={presetValue} onChange={e => {
            const p = SCALE_PRESETS.find(x => x.label === e.target.value)
            if (p) onPreset({ pointsPerFoot: p.pointsPerFoot, label: p.label })
          }}>
            <option value="">{scale && !presetValue ? scale.label : 'Choose scale…'}</option>
            <optgroup label="Architectural">
              {SCALE_PRESETS.filter(p => !p.label.startsWith('1" = ')).map(p => <option key={p.label}>{p.label}</option>)}
            </optgroup>
            <optgroup label="Engineering">
              {SCALE_PRESETS.filter(p => p.label.startsWith('1" = ')).map(p => <option key={p.label}>{p.label}</option>)}
            </optgroup>
          </select>
        </label>
        <div className="scale-actions">
          <button onClick={onCalibrate}>Calibrate…</button>
          <button onClick={onApplyAll} disabled={!scale}>Apply to all sheets</button>
          {scale && <button onClick={onClear}>Clear</button>}
        </div>
      </fieldset>
      {error && <div className="error">{error}</div>}
    </section>
  )
}

interface DialogProps {
  pageCount: number
  onCancel: () => void
  onApply: (feet: number, allSheets: boolean) => Promise<void>
}

/** Asks for the real-world length of the calibration line. */
export function CalibrateDialog({ pageCount, onCancel, onApply }: DialogProps) {
  const [text, setText] = useState('')
  const [all, setAll] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const feet = parseFeetInches(text)
    if (feet === null || feet <= 0) { setError(`Enter a length like 12'-6", 12' 6 1/2", 150" or 12.5`); return }
    setSaving(true)
    try { await onApply(feet, all) } catch (err) { setError((err as Error).message); setSaving(false) }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel} onKeyDown={e => { if (e.key === 'Escape') onCancel() }}>
      <form className="card modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h3>Calibrate scale</h3>
        <label className="field">Known length
          <input ref={input} value={text} placeholder={`e.g. 12'-6"`} onChange={e => { setText(e.target.value); setError('') }}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Apply to all sheets{pageCount > 1 ? ` (${pageCount})` : ''}</label>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Set scale'}</button>
        </div>
      </form>
    </div>
  )
}
