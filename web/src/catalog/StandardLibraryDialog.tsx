import { useEffect, useState } from 'react'
import { api } from '../api'

/** What the server reports for the Standard device library (preview and result share this shape). */
export interface LibrarySummary {
  /** Cable types added (absent from older servers). */
  cableTypesAdded?: number
  setsCreated: number
  typesAdded: number
  typesUpdated: number
  unchanged: number
  customIconsKept: number
  skippedSets: string[]
  skippedTypes: string[]
  newSets: string[]
  addedTypes: { set: string; name: string }[]
  updatedTypes: { set: string; name: string; changes: string[] }[]
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** Admin: installs or updates the built-in device library (a symbol set per category, a device type per device). Shows what will change first. */
export function StandardLibraryDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void | Promise<void> }) {
  const [preview, setPreview] = useState<LibrarySummary | null>(null)
  const [result, setResult] = useState<LibrarySummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { api<LibrarySummary>('/catalog/standard-library').then(setPreview).catch(e => setError((e as Error).message)) }, [])

  async function apply() {
    setBusy(true); setError('')
    try {
      setResult(await api<LibrarySummary>('/catalog/standard-library', { method: 'POST' }))
      await onDone()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const s = result ?? preview
  const nothing = !!s && !s.setsCreated && !s.typesAdded && !s.typesUpdated && !s.cableTypesAdded
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal wide" role="dialog" aria-label="Standard device library" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>Standard device library</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        <p className="muted small">
          Adds a symbol set per category (Fire Alarm, Access Control, Cameras, Network, Intrusion, Intercom, Nurse Call, Paging / Audio,
          Automation, General) and a device type for each of the 145 devices, with icon, mount and tag prefix. Existing types with a matching name
          get any missing icon, mount, prefix or coverage filled in. Custom icons, names and everything else are kept, and nothing is deleted.
          Running it again is safe.
        </p>
        {!s && !error && <p className="muted">Checking the catalog…</p>}
        {s && (
          <div className="stack" aria-live="polite">
            <strong>{result ? 'Done' : 'This will'}: {plural(s.setsCreated, 'symbol set')} created, {plural(s.typesAdded, 'device type')} added, {plural(s.typesUpdated, 'device type')} updated{s.cableTypesAdded ? `, ${plural(s.cableTypesAdded, 'cable type')} added` : ''}.</strong>
            {nothing && <p className="muted">The catalog already has the whole library.</p>}
            {s.newSets.length > 0 && <p className="small">New sets: {s.newSets.join(', ')}</p>}
            {s.updatedTypes.length > 0 && (
              <details><summary>Updated types ({s.updatedTypes.length})</summary>
                <ul className="small">{s.updatedTypes.map((t, i) => <li key={i}>{t.set} / {t.name}: {t.changes.join(', ')}</li>)}</ul>
              </details>
            )}
            {s.customIconsKept > 0 && <p className="muted small">{plural(s.customIconsKept, 'custom icon')} kept as they are.</p>}
            {s.skippedSets.length > 0 && <p className="muted small">Skipped, removed sets: {s.skippedSets.join(', ')}</p>}
            {s.skippedTypes.length > 0 && <p className="muted small">Skipped, removed types: {s.skippedTypes.join(', ')}</p>}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          {!result && <button className="primary" onClick={apply} disabled={busy || !preview || nothing}>{busy ? 'Installing…' : 'Install / update'}</button>}
        </div>
      </div>
    </div>
  )
}
