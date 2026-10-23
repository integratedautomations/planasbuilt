import { useState } from 'react'
import { api } from '../api'
import type { CableType } from './types'

/** Catalog > Cable types: name and canvas colour. Removing archives (cables already drawn keep their name and colour). */
export function CableTypesPanel({ types, admin, onChanged, onError }: { types: CableType[]; admin: boolean; onChanged: () => void | Promise<void>; onError: (m: string) => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#1971c2')
  const [busy, setBusy] = useState(false)
  const active = types.filter(t => !t.archived)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); onError('')
    try { await fn(); await onChanged() } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }
  const add = () => run(async () => { await api('/cable-types', { method: 'POST', body: JSON.stringify({ name, color }) }); setName('') })
  const save = (t: CableType, patch: Partial<CableType>) => run(() => api(`/cable-types/${t.id}`, { method: 'PUT', body: JSON.stringify({ name: t.name, color: t.color, ...patch }) }))
  const remove = (t: CableType) => {
    if (window.confirm(`Remove cable type "${t.name}"? Cables already drawn with it keep it; it is no longer offered for new ones.`)) void run(() => api(`/cable-types/${t.id}`, { method: 'DELETE' }))
  }

  return (
    <>
      <h3>Cable types</h3>
      <p className="muted small">Pick one on a cable run in Properties. The run is drawn in the type's colour and totalled per type in the BOM and the Measure panel. "Install / update standard library" adds Cat6, Cat6A, 18/2, 18/4, 22/4, RG6 and Fiber.</p>
      {active.length === 0 && <p className="muted">No cable types yet.</p>}
      <ul className="layer-list cable-types">
        {active.map(t => (
          <li key={t.id}>
            {admin ? (
              <>
                <input type="color" aria-label={`${t.name} colour`} value={t.color} disabled={busy} onChange={e => void save(t, { color: e.target.value })} />
                <input aria-label="Name" defaultValue={t.name} disabled={busy} onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.name) void save(t, { name: v }); else e.target.value = t.name }} />
                <button className="danger" disabled={busy} onClick={() => remove(t)}>Remove</button>
              </>
            ) : <span className="layer-name"><span className="dot" style={{ background: t.color }} />{t.name}</span>}
          </li>
        ))}
      </ul>
      {admin && (
        <form className="row" onSubmit={e => { e.preventDefault(); if (name.trim()) void add() }}>
          <input type="color" aria-label="New cable type colour" value={color} onChange={e => setColor(e.target.value)} />
          <input placeholder="New cable type, e.g. Cat6A" value={name} onChange={e => setName(e.target.value)} />
          <button disabled={busy || !name.trim()}>Add</button>
        </form>
      )}
    </>
  )
}
