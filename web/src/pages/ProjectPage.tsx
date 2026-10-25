import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, documentFileUrl, fetchBlob } from '../api'
import type { DocumentRevision, DocumentSummary, RevisionUpload, User } from '../api'
import { docCacheStates, invalidatePdf, loadDocuments, makeProjectOffline, projectCacheSize } from '../offline/cache'
import type { Progress } from '../offline/cache'
import { requestPersistence } from '../offline/storagePersist'
import { noteMadeOffline } from '../offline/installPrompt'
import { loadPdf } from '../pdf'
import { exportProjectReport } from '../pdfio/actions'
import { ReportDialog } from '../pdfio/ReportDialog'
import type { ReportOptions } from '../pdfio/reportOptions'
import { exportProjectSchedule } from '../schedule/exportProject'
import { makeRevisionCurrent } from '../revisions/api'
import { IssueRevisionDialog } from '../revisions/IssueRevisionDialog'
import { Icon } from '../ui/Icon'
import { startFolderDownload } from './DownloadProjectFolder'
import { useProject, ProjectBody } from '../shell/ProjectShell'
import { lockedFor } from '../projectSettings'
import { cableSettings } from '../markups/cables'
import { can } from '../roles'

/** Page count of a PDF; the pdf.js task is destroyed whether it parses or is rejected. */
async function countPages(bytes: ArrayBuffer): Promise<number> {
  const task = loadPdf(bytes)
  try { return (await task.promise).numPages } finally { void task.destroy() }
}

/** Opens a (login-protected) PDF in a new tab: fetched with the Authorization header, shown from a blob URL. */
async function openPdf(docId: string, revisionId: string, onError: (m: string) => void) {
  const tab = window.open('', '_blank') // opened synchronously so pop-up blockers allow it
  try {
    const blob = await fetchBlob(documentFileUrl(docId, revisionId))
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
    if (tab) tab.location.href = url; else window.location.href = url
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
  } catch (err) {
    tab?.close()
    onError(`Could not open the PDF: ${(err as Error).message}`)
  }
}

/** A ⋯ bubble + pop-up menu. Closes on outside press, Escape, or choosing an item. */
function PopMenu({ label, className = '', children, text }: { label: string; className?: string; children: React.ReactNode; text?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className={`pp-menu ${className}`} ref={ref}>
      <button type="button" className={text ? 'pp-actions-btn' : 'pp-bubble'} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}
        onClick={() => setOpen(o => !o)}>
        {text ? <>{text} <Icon name="chevron-down" size={14} /></> : <Icon name="dots" size={20} />}
      </button>
      {open && <div className="pp-popup right" role="menu" onClick={e => { if ((e.target as HTMLElement).closest('[role^="menuitem"]')) setOpen(false) }}>{children}</div>}
    </div>
  )
}

/** Plans tab: the project's plans, with Upload PDF and one Actions menu. Header, tabs and Mark complete come from ProjectShell. */
export function ProjectPage({ user }: { user: User }) {
  void user
  const { projectId } = useParams()
  const { project } = useProject()
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [folderBusy, setFolderBusy] = useState(false)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState('')
  const [exporting, setExporting] = useState(false)
  const [reporting, setReporting] = useState<string>('')
  const [reportOpen, setReportOpen] = useState(false)
  const revInput = useRef<HTMLInputElement>(null)
  const revTarget = useRef<DocumentSummary | null>(null)
  const [revising, setRevising] = useState('')
  const [revNotice, setRevNotice] = useState('')
  const [openRevs, setOpenRevs] = useState<string | null>(null)
  const [issuing, setIssuing] = useState<DocumentSummary | null>(null)
  const [renaming, setRenaming] = useState<DocumentSummary | null>(null)
  const [newName, setNewName] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [revs, setRevs] = useState<DocumentRevision[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [offlineState, setOfflineState] = useState<Map<string, { offline: boolean }>>(new Map())
  const [cacheBytes, setCacheBytes] = useState(0)
  const [progress, setProgress] = useState<Progress | null>(null)

  useEffect(() => {
    loadDocuments(projectId!).then(r => setDocs(r.data)).catch(e => setError(e.message))
  }, [projectId])

  const refreshOffline = async (list: DocumentSummary[]) => {
    const ids = list.map(d => d.id)
    setOfflineState(await docCacheStates(ids))
    setCacheBytes(await projectCacheSize(ids))
  }
  useEffect(() => { void refreshOffline(docs) }, [docs])

  async function makeOffline() {
    setError(''); setProgress({ done: 0, total: 1, label: 'Starting' })
    try {
      const list = await makeProjectOffline(projectId!, setProgress)
      setDocs(list)
      await refreshOffline(list)
      void requestPersistence(); noteMadeOffline()
    } catch (err) { setError(`Could not save for offline: ${(err as Error).message}`) }
    finally { setProgress(null) }
  }

  const allOffline = docs.length > 0 && docs.every(d => offlineState.get(d.id)?.offline)
  const locked = lockedFor(project?.role, { locked: project?.settings?.locked === true })
  const canEdit = can(project?.role, 'plans.edit') && !locked
  const canDeletePlans = can(project?.role, 'plans.delete')

  async function downloadFolder() {
    setFolderBusy(true); setError('')
    const err = await startFolderDownload(projectId!)
    if (err) setError(err)
    setTimeout(() => setFolderBusy(false), 1500)
  }

  async function upload(files: FileList | null) {
    if (!files) return
    setError('')
    for (const file of Array.from(files)) {
      setUploading(file.name)
      try {
        // Count pages in the browser so the server stays lightweight
        const numPages = await countPages(await file.arrayBuffer())
        const form = new FormData()
        form.append('pageCount', String(numPages))
        form.append('file', file)
        const doc = await api<DocumentSummary>(`/projects/${projectId}/documents`, { method: 'POST', body: form })
        setDocs(ds => [...ds, doc].sort((a, b) => a.name.localeCompare(b.name)))
      } catch (err) {
        setError(`${file.name}: ${(err as Error).message}`)
      }
    }
    setUploading('')
    if (fileInput.current) fileInput.current.value = ''
  }

  async function exportSchedule() {
    if (!project) return
    setExporting(true); setError('')
    try { await exportProjectSchedule(project.id, project.name, cableSettings(project)) }
    catch (err) { setError(`Export failed: ${(err as Error).message}`) }
    finally { setExporting(false) }
  }

  async function asBuiltReport(options: ReportOptions) {
    if (!project) return
    setReportOpen(false)
    setReporting('Starting…'); setError('')
    try { await exportProjectReport(project.id, project.name, options, (d, t, label) => setReporting(`${d}/${t} ${label}`)) }
    catch (err) { setError(`Report failed: ${(err as Error).message}`) }
    finally { setReporting('') }
  }

  async function showRevisions(doc: DocumentSummary) {
    if (openRevs === doc.id) { setOpenRevs(null); return }
    setOpenRevs(doc.id); setRevs([])
    try { setRevs(await api<DocumentRevision[]>(`/documents/${doc.id}/revisions`)) } catch (err) { setError((err as Error).message) }
  }

  async function uploadRevision(file: File | undefined) {
    const doc = revTarget.current
    if (revInput.current) revInput.current.value = ''
    if (!file || !doc) return
    setError(''); setRevNotice(''); setRevising(doc.id)
    try {
      const numPages = await countPages(await file.arrayBuffer())
      const form = new FormData()
      form.append('pageCount', String(numPages))
      form.append('file', file)
      const rev = await api<RevisionUpload>(`/documents/${doc.id}/revisions`, { method: 'POST', body: form })
      await invalidatePdf(doc.id) // the stored offline copy is the old revision
      setDocs(ds => ds.map(d => d.id === doc.id ? { ...d, revision: rev.revision, revision_id: rev.id, page_count: rev.page_count } : d))
      if (openRevs === doc.id) setRevs(await api<DocumentRevision[]>(`/documents/${doc.id}/revisions`))
      setRevNotice(`${doc.name}: Rev ${rev.revision} is now current. Markups carried forward.` + (rev.orphaned_markups
        ? ` ${rev.orphaned_markups} markup${rev.orphaned_markups === 1 ? ' is' : 's are'} on page${rev.orphaned_pages.length === 1 ? '' : 's'} ${rev.orphaned_pages.join(', ')} which the new revision doesn't have (kept, flagged in the viewer).` : ''))
    } catch (err) { setError(`${file.name}: ${(err as Error).message}`) }
    finally { setRevising('') }
  }

  async function setAsCurrent(doc: DocumentSummary, r: DocumentRevision) {
    if (!confirm(`Make Rev ${r.revision}${r.label ? ` (${r.label})` : ''} the current plan?

Its PDF, markups and scales are restored as a new revision. The present state is saved first as "Before restoring Rev ${r.revision}"; no revision is deleted.`)) return
    setError(''); setRevNotice('')
    try {
      const res = await makeRevisionCurrent(doc.id, r.id)
      await invalidatePdf(doc.id)
      setDocs(ds => ds.map(d => d.id === doc.id ? { ...d, revision: res.revision, revision_id: res.id, page_count: res.page_count } : d))
      setRevs(await api<DocumentRevision[]>(`/documents/${doc.id}/revisions`))
      setRevNotice(`${doc.name}: ${res.label}.`)
    } catch (err) { setError((err as Error).message) }
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault()
    if (!renaming) return
    const name = newName.trim()
    if (!name) { setError('Give the plan a name'); return }
    setRenameBusy(true); setError('')
    try {
      const updated = await api<{ name: string }>(`/documents/${renaming.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      const id = renaming.id
      setDocs(ds => ds.map(d => d.id === id ? { ...d, name: updated.name ?? name } : d))
      setRenaming(null)
    } catch (err) { setError((err as Error).message) } finally { setRenameBusy(false) }
  }

  async function remove(doc: DocumentSummary) {
    if (!confirm(`Delete "${doc.name}"? This removes the plan and its markups.`)) return
    await api(`/documents/${doc.id}`, { method: 'DELETE' })
    setDocs(ds => ds.filter(d => d.id !== doc.id))
  }

  return (
    <ProjectBody width="wide">
        <div className="row pp-toolbar">
          <h2>Plans</h2>
          <span className="spacer" />
          {canEdit && (
            <>
              <input ref={revInput} type="file" accept="application/pdf,.pdf" hidden onChange={e => uploadRevision(e.target.files?.[0])} />
              <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden
                onChange={e => upload(e.target.files)} />
              <button className="primary pp-upload" disabled={!!uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? `Uploading ${uploading}…` : 'Upload PDF'}
              </button>
            </>
          )}
          <PopMenu label="Actions" text="Actions" className="pp-more">
            <button role="menuitem" className="vmenu-item" disabled={!!progress || docs.length === 0} onClick={makeOffline}
              title="Download every plan, its markups, layers, symbols and scales to this device">
              <span className="vmenu-label">{allOffline ? 'Refresh offline copy' : 'Make available offline'}</span>
            </button>
            <button role="menuitem" className="vmenu-item" disabled={!project || exporting} onClick={exportSchedule}
              title="Download every device and measurement as an Excel workbook">
              <span className="vmenu-label">{exporting ? 'Exporting…' : 'Export schedule'}</span>
            </button>
            <button role="menuitem" className="vmenu-item" disabled={!project || folderBusy} onClick={() => void downloadFolder()}
              title="A zip of the project's plans, photos and device list, in the same folders as on the file share">
              <span className="vmenu-label">{folderBusy ? 'Preparing…' : 'Download project folder'}</span>
            </button>
            <button role="menuitem" className="vmenu-item" disabled={!project || !!reporting || docs.length === 0} onClick={() => setReportOpen(true)}
              title="One PDF: every sheet with markups, then a page per device with its details and photos">
              <span className="vmenu-label">{reporting ? `Building report… ${reporting}` : 'As-built report'}</span>
            </button>
          </PopMenu>
        </div>
        {progress && (
          <div>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(progress.done / progress.total * 100)}>
              <div style={{ width: `${Math.round(progress.done / progress.total * 100)}%` }} />
            </div>
            <span className="muted small">Saving {progress.label}…</span>
          </div>
        )}
        {cacheBytes > 0 && <div className="muted small">{(cacheBytes / 1048576).toFixed(1)} MB saved on this device</div>}
        {error && <div className="error">{error}</div>}
        {revNotice && <div className="muted small" role="status">{revNotice}</div>}
        {docs.length === 0 ? <p className="muted">No plans yet.{canEdit && ' Upload a PDF to start.'}</p> : (
          <ul className="plan-grid">
            {docs.map(d => (
              <li key={d.id} className="plan-card">
                <Link to={`/projects/${projectId}/documents/${d.id}`} className="plan-link">
                  <span className="list-title plan-name">{d.name}</span>
                  <span className="muted small">{d.page_count} page{d.page_count === 1 ? '' : 's'} · Rev {d.revision}
                    {offlineState.get(d.id)?.offline && <span className="offline-badge" title="Available offline"> · offline ✓</span>}</span>
                </Link>
                <PopMenu label={`Actions for ${d.name}`} className="pp-card-menu">
                  <button role="menuitem" className="vmenu-item" aria-expanded={openRevs === d.id} onClick={() => showRevisions(d)}>
                    <span className="vmenu-label">Revisions</span>
                  </button>
                  {canEdit && (
                    <button role="menuitem" className="vmenu-item" disabled={!!revising} title="Upload a newer PDF of this plan; markups carry forward"
                      onClick={() => { revTarget.current = d; revInput.current?.click() }}>
                      <span className="vmenu-label">{revising === d.id ? 'Uploading…' : 'New revision'}</span>
                    </button>
                  )}
                  {canEdit && (
                    <button role="menuitem" className="vmenu-item" onClick={() => { setRenaming(d); setNewName(d.name) }}>
                      <span className="vmenu-label">Rename</span>
                    </button>
                  )}
                  {canEdit && (
                    <button role="menuitem" className="vmenu-item" title="Freeze this plan's PDF and all markups as a named revision" onClick={() => setIssuing(d)}>
                      <span className="vmenu-label">Issue revision</span>
                    </button>
                  )}
                  {canDeletePlans && (
                    <button role="menuitem" className="vmenu-item pp-danger" onClick={() => remove(d)}>
                      <span className="vmenu-label">Delete</span>
                    </button>
                  )}
                </PopMenu>
                {openRevs === d.id && (
                  <ul className="rev-list small">
                    {revs.length === 0 && <li className="muted">Loading…</li>}
                    {revs.map(r => (
                      <li key={r.id}>
                        <strong>Rev {r.revision}</strong>{r.label && ` · ${r.label}`}{r.kind === 'issued' && <> <span className="rev-kind">issued</span></>}{r.kind === 'restore' && <> <span className="rev-kind">restore</span></>}
                        {r.revision === d.revision && ' (current)'} · {new Date(r.created_at).toLocaleDateString()}
                        {r.uploaded_by_name && ` · ${r.uploaded_by_name}`} · {r.page_count} page{r.page_count === 1 ? '' : 's'}
                        {r.note && <div className="muted">{r.note}</div>}
                        {' · '}<Link to={`/projects/${projectId}/documents/${d.id}${r.revision === d.revision ? '' : `?rev=${r.id}`}`}>View</Link>
                        {r.revision !== d.revision && <>{' · '}<Link to={`/projects/${projectId}/documents/${d.id}?compare=${r.id}`}>Compare with current</Link></>}
                        {' · '}<button className="link-btn" onClick={() => openPdf(d.id, r.id, setError)}>Open PDF</button>
                        {canEdit && r.revision !== d.revision && r.has_snapshot && <>{' · '}<button className="link-btn" title="Restore this revision as a new current one; newer revisions are kept" onClick={() => setAsCurrent(d, r)}>Set as current</button></>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {reportOpen && project && (
          <ReportDialog projectName={project.name} docs={docs} busy={!!reporting} onGenerate={asBuiltReport} onClose={() => setReportOpen(false)} />
        )}
        {renaming && (
          <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
            <form onSubmit={submitRename} onKeyDown={e => { if (e.key === 'Escape') setRenaming(null) }}>
              <div className="panel-heading">Rename plan</div>
              <label className="field-row">Name
                <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} aria-label="Plan name" onFocus={e => e.currentTarget.select()} />
              </label>
              <div className="row">
                <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                <button type="submit" className="primary" disabled={renameBusy}>{renameBusy ? 'Saving…' : 'Rename'}</button>
              </div>
            </form>
          </div>
        )}
        {issuing && (
          <IssueRevisionDialog documentId={issuing.id} documentName={issuing.name} nextRevision={issuing.revision + 1}
            onClose={() => setIssuing(null)}
            onIssued={rev => {
              const doc = issuing
              setIssuing(null)
              setDocs(ds => ds.map(d => d.id === doc.id ? { ...d, revision: rev.revision, revision_id: rev.id } : d))
              if (openRevs === doc.id) api<DocumentRevision[]>(`/documents/${doc.id}/revisions`).then(setRevs).catch(() => {})
              setRevNotice(`${doc.name}: issued ${rev.label || `Rev ${rev.revision}`}.`)
            }} />
        )}
    </ProjectBody>
  )
}
