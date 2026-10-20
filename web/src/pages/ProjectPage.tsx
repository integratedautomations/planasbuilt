import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, documentFileUrl } from '../api'
import type { DocumentRevision, DocumentSummary, Project, RevisionUpload, User } from '../api'
import { docCacheStates, invalidatePdf, loadDocuments, loadProject, makeProjectOffline, projectCacheSize } from '../offline/cache'
import type { Progress } from '../offline/cache'
import { OfflineBanner } from '../offline/OfflineBanner'
import { loadPdf } from '../pdf'
import { exportProjectReport } from '../pdfio/actions'
import { ReportDialog } from '../pdfio/ReportDialog'
import type { ReportOptions } from '../pdfio/reportOptions'
import { exportProjectSchedule } from '../schedule/exportProject'
import { makeRevisionCurrent } from '../revisions/api'
import { IssueRevisionDialog } from '../revisions/IssueRevisionDialog'
import { Brand } from '../Brand'
import { UserMenu } from '../settings/UserMenu'
import { MembersPanel } from '../settings/MembersPanel'

export function ProjectPage({ user }: { user: User }) {
  const { projectId } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [tab, setTab] = useState<'plans' | 'members'>('plans')
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
  const [revs, setRevs] = useState<DocumentRevision[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [offlineState, setOfflineState] = useState<Map<string, { offline: boolean }>>(new Map())
  const [cacheBytes, setCacheBytes] = useState(0)
  const [progress, setProgress] = useState<Progress | null>(null)

  useEffect(() => {
    loadProject(projectId!).then(r => setProject(r.data)).catch(e => setError(e.message))
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
    } catch (err) { setError(`Could not save for offline: ${(err as Error).message}`) }
    finally { setProgress(null) }
  }

  const allOffline = docs.length > 0 && docs.every(d => offlineState.get(d.id)?.offline)
  const canEdit = project?.role === 'admin' || project?.role === 'editor'
  const isAdmin = project?.role === 'admin'

  async function upload(files: FileList | null) {
    if (!files) return
    setError('')
    for (const file of Array.from(files)) {
      setUploading(file.name)
      try {
        // Count pages in the browser so the server stays lightweight
        const task = loadPdf(await file.arrayBuffer())
        const { numPages } = await task.promise
        task.destroy()
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
    try { await exportProjectSchedule(project.id, project.name) }
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
      const task = loadPdf(await file.arrayBuffer())
      const { numPages } = await task.promise
      task.destroy()
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

  async function remove(doc: DocumentSummary) {
    if (!confirm(`Delete "${doc.name}"? This removes the plan and its markups.`)) return
    await api(`/documents/${doc.id}`, { method: 'DELETE' })
    setDocs(ds => ds.filter(d => d.id !== doc.id))
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <span className="muted">/</span>
        <span className="crumb">{project?.name ?? '…'}</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'plans'} className={`tab${tab === 'plans' ? ' active' : ''}`} onClick={() => setTab('plans')}>Plans</button>
          <button role="tab" aria-selected={tab === 'members'} className={`tab${tab === 'members' ? ' active' : ''}`} onClick={() => setTab('members')}>Members</button>
        </div>
        {tab === 'members' && <MembersPanel projectId={projectId!} canManage={!!isAdmin} me={user} />}
        {tab === 'plans' && <>
        <div className="row">
          <h2>Plans</h2>
          <span className="spacer" />
          <button disabled={!!progress || docs.length === 0} onClick={makeOffline}
            title="Download every plan, its markups, layers, symbols and scales to this device">
            {allOffline ? 'Refresh offline copy' : 'Make available offline'}
          </button>
          <Link className="btn-link" to={`/projects/${projectId}/bom`} title="Bill of materials: quantities, cost and labor">BOM</Link>
          <button disabled={!project || exporting} onClick={exportSchedule} title="Download every device and measurement as an Excel workbook">
            {exporting ? 'Exporting…' : 'Export schedule'}
          </button>
          <button disabled={!project || !!reporting || docs.length === 0} onClick={() => setReportOpen(true)}
            title="One PDF: every sheet with markups, then a page per device with its details and photos">
            {reporting ? `Building report… ${reporting}` : 'As-built report'}
          </button>
          {canEdit && (
            <>
              <input ref={revInput} type="file" accept="application/pdf,.pdf" hidden onChange={e => uploadRevision(e.target.files?.[0])} />
              <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden
                onChange={e => upload(e.target.files)} />
              <button className="primary" disabled={!!uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? `Uploading ${uploading}…` : 'Upload PDF'}
              </button>
            </>
          )}
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
          <ul className="list">
            {docs.map(d => (
              <li key={d.id} className="list-row">
                <Link to={`/projects/${projectId}/documents/${d.id}`} className="list-item grow">
                  <span className="list-title">{d.name}</span>
                  <span className="muted">{d.page_count} page{d.page_count === 1 ? '' : 's'} · Rev {d.revision}
                    {offlineState.get(d.id)?.offline && <span className="offline-badge" title="Available offline"> · offline ✓</span>}</span>
                </Link>
                <button onClick={() => showRevisions(d)} aria-expanded={openRevs === d.id}>Revisions</button>
                {canEdit && (
                  <button disabled={!!revising} title="Upload a newer PDF of this plan; markups carry forward"
                    onClick={() => { revTarget.current = d; revInput.current?.click() }}>
                    {revising === d.id ? 'Uploading…' : 'New revision'}
                  </button>
                )}
                {canEdit && (
                  <button title="Freeze this plan's PDF and all markups as a named revision" onClick={() => setIssuing(d)}>Issue revision</button>
                )}
                {isAdmin && <button className="danger" onClick={() => remove(d)}>Delete</button>}
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
                        {' · '}<a href={documentFileUrl(d.id, r.id)} target="_blank" rel="noreferrer">Open PDF</a>
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
        </>}
      </main>
    </div>
  )
}
