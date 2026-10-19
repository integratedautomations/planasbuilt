import { useState } from 'react'
import type { DocumentRevision } from '../api'
import { issueRevision } from './api'

interface Props {
  documentId: string
  documentName: string
  /** Number the issued revision will get, for the suggested name. */
  nextRevision: number
  onIssued: (rev: DocumentRevision) => void
  onClose: () => void
}

/** Asks for a name and note, then freezes the plan's PDF and all markups as a numbered revision. */
export function IssueRevisionDialog({ documentId, documentName, nextRevision, onIssued, onClose }: Props) {
  const [label, setLabel] = useState(`Rev ${nextRevision}`)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!label.trim()) { setError('Give the revision a name'); return }
    setBusy(true); setError('')
    try { onIssued(await issueRevision(documentId, label.trim(), note.trim())) }
    catch (err) { setError((err as Error).message); setBusy(false) }
  }

  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <form onSubmit={submit} onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <div className="panel-heading">Issue revision</div>
        <p className="muted small">Freezes {documentName} as it is now: the PDF, every markup and all device data. Later edits do not change it.</p>
        <label className="field-row">Name
          <input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder="Rev 2 - As-built" aria-label="Revision name" onFocus={e => e.currentTarget.select()} />
        </label>
        <label className="field-row">Note
          <textarea value={note} rows={3} onChange={e => setNote(e.target.value)} placeholder="What changed, who asked for it" aria-label="Revision note" />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Issuing…' : 'Issue'}</button>
        </div>
      </form>
    </div>
  )
}
