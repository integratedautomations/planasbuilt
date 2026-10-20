import type { DocumentRevision } from '../api'
import { revisionName } from './api'
import { MenuHeading, MenuItemBtn } from '../viewer/menuParts'

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

/** Revision entries of the viewer's ⋯ menu: issue a revision, open an earlier one read-only, start a compare. */
export function RevisionMenu({ revisions, viewingId, canEdit, onIssue, onCompare, onView, onMakeCurrent }: Props) {
  return (
    <>
      <MenuHeading>Revisions</MenuHeading>
      {canEdit && <MenuItemBtn icon="plus" label="Issue revision…" onClick={onIssue} />}
      <MenuItemBtn icon="compare" label="Compare revisions…" onClick={onCompare} disabled={revisions.length < 2} />
      {viewingId && <MenuItemBtn icon="arrow-left" label="Back to current" onClick={() => onView(null)} />}
      <MenuHeading>View read-only</MenuHeading>
      {revisions.map((r, i) => {
        const on = viewingId === r.id || (!viewingId && i === 0)
        return (
          <MenuItemBtn key={r.id} checked={on} onClick={() => onView(i === 0 ? null : r.id)}
            label={`${revisionName(r)}${i === 0 ? ' (current)' : ''}${r.kind === 'issued' ? ' · issued' : ''}`} />
        )
      })}
      {canEdit && onMakeCurrent && revisions.slice(1).some(r => r.has_snapshot) && (
        <>
          <MenuHeading>Set as current</MenuHeading>
          {revisions.slice(1).filter(r => r.has_snapshot).map(r => (
            <MenuItemBtn key={r.id} label={`${revisionName(r)}…`} title="Restore this revision's plan, markups and scales as a new revision; nothing is deleted"
              onClick={() => onMakeCurrent(r)} />
          ))}
        </>
      )}
    </>
  )
}
