import { useEffect, useState } from 'react'
import { api } from '../api'
import { describeEvent, formatWhen } from './history'
import type { HistoryEvent } from './history'
import type { Markup, SymbolSet } from './types'

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
