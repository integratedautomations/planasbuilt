import { useRef } from 'react'
import type { DocumentRevision } from '../api'
import { revisionName } from './api'

interface Props {
  revisions: DocumentRevision[]
  /** Revision shown read-only right now, if any. */
  viewingId: string | null
  canEdit: boolean
  onIssue: () => void
  onCompare: () => void
  /** Open a revision read-only; null returns to the current plan. */
  onView: (id: string | null) => void
  /** Make an earlier revision current again (after confirming); newer ones are kept. */
  onMakeCurrent?: (r: DocumentRevision) => void
}

/** Viewer toolbar menu: issue a revision, open an earlier one read-only, start a compare. */
export function RevisionMenu({ revisions, viewingId, canEdit, onIssue, onCompare, onView, onMakeCurrent }: Props) {
  const menu = useRef<HTMLDetailsElement>(null)
  const close = () => { if (menu.current) menu.current.open = false }
  const run = (fn: () => void) => () => { close(); fn() }
  return (
    <details className="pdf-menu" ref={menu}>
      <summary className="icon-btn" title="Revisions: issue, view or compare" aria-label="Revisions">Rev</summary>
      <div className="menu" role="menu">
        {canEdit && <button role="menuitem" onClick={run(onIssue)}>Issue revision…</button>}
        <button role="menuitem" onClick={run(onCompare)} disabled={revisions.length < 2}>Compare revisions…</button>
        {viewingId && <button role="menuitem" onClick={run(() => onView(null))}>Back to current</button>}
        <div className="muted small" style={{ padding: '4px 8px' }}>View read-only</div>
        {revisions.map((r, i) => (
          <button key={r.id} role="menuitemradio" aria-checked={viewingId === r.id || (!viewingId && i === 0)}
            onClick={run(() => onView(i === 0 ? null : r.id))}>
            {(viewingId === r.id || (!viewingId && i === 0)) ? '✓ ' : ''}{revisionName(r)}{i === 0 ? ' (current)' : ''}{r.kind === 'issued' ? ' · issued' : ''}
          </button>
        ))}
        {canEdit && onMakeCurrent && revisions.slice(1).some(r => r.has_snapshot) && (
          <>
            <div className="muted small" style={{ padding: '4px 8px' }}>Set as current</div>
            {revisions.slice(1).filter(r => r.has_snapshot).map(r => (
              <button key={r.id} role="menuitem" title="Restore this revision's plan, markups and scales as a new revision; nothing is deleted"
                onClick={run(() => onMakeCurrent(r))}>{revisionName(r)}…</button>
            ))}
          </>
        )}
      </div>
    </details>
  )
}
