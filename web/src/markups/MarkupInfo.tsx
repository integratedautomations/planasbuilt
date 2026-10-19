import { useEffect, useState } from 'react'
import { api } from '../api'
import { describeEvent, formatWhen } from './history'
import type { HistoryEvent } from './history'
import type { Markup, SymbolSet } from './types'
import { popupFieldOptions, popupRows } from './popupFields'

/** "Placed by Dana · Oct 19" / "Last edited by Sam · 2h ago". Markups made this session show "you" until reload. */
export function Attribution({ markup: m }: { markup: Markup }) {
  const placed = m.created_by_name || (m.created_by ? '' : 'you')
  const edited = m.updated_by_name || (m.updated_by || m.created_by ? '' : 'you')
  const line = (label: string, who: string, at?: string) => {
    const when = formatWhen(at)
    return <div className="muted small">{label} {who}{when ? ` · ${when}` : ''}</div>
  }
  if (!placed && !edited) return null
  return (
    <div className="attribution">
      {placed && line('Placed by', placed, m.created_at)}
      {edited && line('Last edited by', edited, m.updated_at)}
    </div>
  )
}

/** Collapsible change history, fetched when opened and again whenever the markup is saved. */
export function HistorySection({ markup: m, set }: { markup: Markup; set?: SymbolSet }) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  const [error, setError] = useState('')

  // A different markup starts collapsed again
  useEffect(() => { setOpen(false); setEvents(null); setError('') }, [m.id])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api<HistoryEvent[]>(`/markups/${m.id}/history`)
      .then(rows => { if (!cancelled) { setEvents(rows); setError('') } })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [open, m.id, m.version, m.updated_at])

  return (
    <div className="history stack">
      <button type="button" className="history-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span aria-hidden>{open ? '▾' : '▸'}</span> History
      </button>
      {open && (
        <>
          {error && <div className="muted small">Could not load history: {error}</div>}
          {!error && !events && <div className="muted small">Loading…</div>}
          {events && events.length === 0 && <div className="muted small">No history yet.</div>}
          {events && (
            <ul className="history-list">
              {events.flatMap(e => describeEvent(e, set?.fields).map((text, i) => (
                <li key={`${e.id}.${i}`}>
                  <span>{text}</span>
                  <span className="muted small">{formatWhen(e.at)}</span>
                </li>
              )))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** Floating card for the selected markup. The user ticks which fields it shows (saved with their prefs). */
export function MarkupPopup({ markup: m, set, sets, areaPath, fields, onFields }: {
  markup: Markup
  set?: SymbolSet
  sets: SymbolSet[]
  areaPath?: string[]
  fields: string[]
  onFields: (ids: string[]) => void
}) {
  const [picking, setPicking] = useState(false)
  const [closedFor, setClosedFor] = useState('')
  const options = popupFieldOptions(sets)
  if (closedFor === m.id) return null
  const rows = popupRows(m, fields, options, { set, areaPath })
  const toggle = (id: string) => onFields(fields.includes(id) ? fields.filter(f => f !== id) : [...fields, id])
  return (
    <div className="markup-popup" data-no-pan role="region" aria-label="Markup info" onPointerDown={e => e.stopPropagation()}>
      <div className="popup-head">
        <strong className="ellipsis">{m.tag || (m.type === 'device' ? set?.name : m.type) || 'Markup'}</strong>
        <button className={`icon-btn small${picking ? ' active' : ''}`} title="Choose fields to show" aria-label="Choose popup fields" aria-expanded={picking} onClick={() => setPicking(p => !p)}>⚙</button>
        <button className="icon-btn small" title="Close" aria-label="Close popup" onClick={() => setClosedFor(m.id)}>✕</button>
      </div>
      {picking ? (
        <div className="popup-picker" role="group" aria-label="Fields to show">
          {options.map(o => (
            <label key={o.id} className="check small"><input type="checkbox" checked={fields.includes(o.id)} onChange={() => toggle(o.id)} /> {o.label}</label>
          ))}
        </div>
      ) : (
        <dl className="popup-rows">
          {rows.map(r => <div key={r.id}><dt className="muted small">{r.label}</dt><dd>{r.value}</dd></div>)}
          {rows.length === 0 && <div className="muted small">Nothing to show. Use the gear to choose fields.</div>}
        </dl>
      )}
    </div>
  )
}
