import { useState } from 'react'
import { api } from '../api'
import type { FieldDef, SymbolSet } from '../markups/types'
import type { DeviceType } from './types'
import { MOUNTS } from '../markups/mount'
import type { Mount } from '../markups/mount'
import { FieldsEditor } from './FieldsEditor'
import { MountBadge } from './MountBadge'
import { IconPicker } from './icons/IconPicker'
import { readIcon } from './readIcon'

export interface TypeDraft { id?: string; setId: string; name: string; tag_prefix: string; icon: string; fields: FieldDef[]; default_product_id: string | null; coverage: { on: boolean; angle: number; range_ft: number }; mount?: Mount }

/** A type's editable draft (`setId` carries the symbol set it belongs to). */
export const draftOfType = (t: DeviceType): TypeDraft => ({
  id: t.id, setId: t.symbol_set_id, name: t.name, tag_prefix: t.tag_prefix ?? '', icon: t.icon, fields: t.fields.map(f => ({ ...f })), default_product_id: t.default_product_id,
  coverage: t.coverage ?? { on: false, angle: 90, range_ft: 20 },
  mount: t.mount ?? 'ceiling',
})

/** The device-type editor dialog (name, tag prefix, icon, extra fields). Used by the catalog page and the viewer's tool chest. */
export function DeviceTypeEditor({ initial, set, onClose, onSaved, onRemoved }: {
  initial: TypeDraft
  set: SymbolSet | undefined
  onClose: () => void
  onSaved: (saved: DeviceType) => void | Promise<void>
  onRemoved: (typeId: string, setId: string) => void | Promise<void>
}) {
  const [draft, setDraft] = useState<TypeDraft>(initial)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const mount = draft.mount ?? 'ceiling'

  async function save() {
    setError('')
    try {
      const body = JSON.stringify({ name: draft.name, tag_prefix: draft.tag_prefix, icon: draft.icon, fields: draft.fields, default_product_id: draft.default_product_id, coverage: draft.coverage, mount: draft.mount ?? 'ceiling' })
      const saved = draft.id
        ? await api<DeviceType>(`/device-types/${draft.id}`, { method: 'PUT', body })
        : await api<DeviceType>(`/symbol-sets/${draft.setId}/device-types`, { method: 'POST', body })
      await onSaved(saved)
    } catch (e) { setError((e as Error).message) }
  }

  async function remove() {
    if (!draft.id) return
    if (!confirm(`Remove device type "${initial.name}"? Devices already placed keep their type; it just leaves the palette.`)) return
    setError('')
    try {
      await api(`/device-types/${draft.id}`, { method: 'DELETE' })
      await onRemoved(draft.id, draft.setId)
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="card modal wide" onClick={e => e.stopPropagation()}>
          <div className="row"><h3>{draft.id ? 'Edit device type' : 'New device type'}</h3><span className="spacer" />
            <button onClick={onClose}>Close</button></div>
          <div className="grid2">
            <label className="field">Name<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="field">Tag prefix (blank = set's prefix)
              <input value={draft.tag_prefix} placeholder={set?.tag_prefix}
                onChange={e => setDraft({ ...draft, tag_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
            </label>
            <label className="field">Icon (blank = set's icon)
              <span className="icon-pick-row">
                <MountBadge mount={mount} color={set?.color ?? '#868e96'} src={draft.icon || set?.icon || undefined} size={36} />
                <button type="button" onClick={() => setPicking(true)}>Choose from library…</button>
                <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" aria-label="Upload an icon"
                  onChange={async e => { const f = e.target.files?.[0]; if (f) setDraft({ ...draft, icon: await readIcon(f) }) }} />
                {draft.icon && <button onClick={() => setDraft({ ...draft, icon: '' })}>Use set icon</button>}
              </span>
            </label>
          </div>
          <h4>Mount</h4>
          <p className="muted small">How devices of this type are mounted. Placed devices can override it in Properties.</p>
          <div className="seg mount-seg" role="radiogroup" aria-label="Mount">
            {MOUNTS.map(o => (
              <button key={o.value} type="button" role="radio" aria-checked={mount === o.value} className={mount === o.value ? 'active' : ''}
                title={o.hint} onClick={() => setDraft({ ...draft, mount: o.value })}>
                <MountBadge mount={o.value} color={mount === o.value ? '#fff' : set?.color ?? '#868e96'} src={draft.icon || set?.icon || undefined} size={28} />
                <span>{o.label}</span>
              </button>
            ))}
          </div>
          <h4>Coverage</h4>
          <p className="muted small">New devices of this type get this coverage (motion sensors, speakers, WAPs, smoke detectors: use 360° for a full circle).</p>
          <label className="check"><input type="checkbox" checked={draft.coverage.on}
            onChange={e => setDraft({ ...draft, coverage: { ...draft.coverage, on: e.target.checked } })} /> Coverage on by default</label>
          {draft.coverage.on && (
            <div className="grid2">
              <label className="field">Angle (1–360°)
                <input type="number" min={1} max={360} value={draft.coverage.angle}
                  onChange={e => setDraft({ ...draft, coverage: { ...draft.coverage, angle: Math.min(360, Math.max(1, Math.round(+e.target.value) || 1)) } })} />
              </label>
              <label className="field">Range (feet)
                <input type="number" min={1} step={1} value={draft.coverage.range_ft}
                  onChange={e => setDraft({ ...draft, coverage: { ...draft.coverage, range_ft: Math.max(0, +e.target.value || 0) } })} />
              </label>
            </div>
          )}
          <h4>Extra fields</h4>
          <p className="muted small">On top of the set's fields. Devices of this type show both.</p>
          <FieldsEditor fields={draft.fields} onChange={fields => setDraft({ ...draft, fields })} />
          {error && <div className="error">{error}</div>}
          <div className="row">
            {draft.id && <button className="danger" onClick={remove}>Remove type</button>}
            <span className="spacer" />
            <button className="primary" onClick={save} disabled={!draft.name.trim()}>Save</button>
          </div>
        </div>
      </div>
      {picking && (
        <IconPicker color={set?.color ?? '#1971c2'} mount={mount} suggestName={draft.name} onClose={() => setPicking(false)}
          onPick={url => { setDraft({ ...draft, icon: url }); setPicking(false) }} />
      )}
    </>
  )
}
