import { FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, DocumentSummary, Member, Project, Role, User } from '../api'
import { loadPdf } from '../pdf'

export function ProjectPage({ user }: { user: User }) {
  const { projectId } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api<Project>(`/projects/${projectId}`).then(setProject).catch(e => setError(e.message))
    api<DocumentSummary[]>(`/projects/${projectId}/documents`).then(setDocs).catch(e => setError(e.message))
    api<Member[]>(`/projects/${projectId}/members`).then(setMembers).catch(() => {})
  }, [projectId])

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

  async function remove(doc: DocumentSummary) {
    if (!confirm(`Delete "${doc.name}"? This removes the plan and its markups.`)) return
    await api(`/documents/${doc.id}`, { method: 'DELETE' })
    setDocs(ds => ds.filter(d => d.id !== doc.id))
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">PlanMark</Link>
        <span className="muted">/</span>
        <span className="crumb">{project?.name ?? '…'}</span>
        <span className="spacer" />
        <span className="muted hide-sm">{user.name}</span>
      </header>
      <main className="content">
        <div className="row">
          <h2>Plans</h2>
          <span className="spacer" />
          {canEdit && (
            <>
              <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden
                onChange={e => upload(e.target.files)} />
              <button className="primary" disabled={!!uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? `Uploading ${uploading}…` : 'Upload PDF'}
              </button>
            </>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {docs.length === 0 ? <p className="muted">No plans yet.{canEdit && ' Upload a PDF to start.'}</p> : (
          <ul className="list">
            {docs.map(d => (
              <li key={d.id} className="list-row">
                <Link to={`/projects/${projectId}/documents/${d.id}`} className="list-item grow">
                  <span className="list-title">{d.name}</span>
                  <span className="muted">{d.page_count} page{d.page_count === 1 ? '' : 's'} · Rev {d.revision}</span>
                </Link>
                {isAdmin && <button className="danger" onClick={() => remove(d)}>Delete</button>}
              </li>
            ))}
          </ul>
        )}
        <MembersSection projectId={projectId!} members={members} setMembers={setMembers} isAdmin={isAdmin} />
      </main>
    </div>
  )
}

function MembersSection({ projectId, members, setMembers, isAdmin }: {
  projectId: string; members: Member[]; setMembers: (m: Member[]) => void; isAdmin: boolean
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [error, setError] = useState('')

  async function add(e: FormEvent) {
    e.preventDefault(); setError('')
    try {
      await api(`/projects/${projectId}/members`, { method: 'PUT', body: JSON.stringify({ email, role }) })
      setMembers(await api<Member[]>(`/projects/${projectId}/members`))
      setEmail('')
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <section className="members">
      <h3>Team</h3>
      <ul className="list compact">
        {members.map(m => <li key={m.id} className="list-item">{m.name} <span className="muted">{m.email} · {m.role}</span></li>)}
      </ul>
      {isAdmin && (
        <form className="row wrap" onSubmit={add}>
          <input type="email" placeholder="Teammate email" value={email} onChange={e => setEmail(e.target.value)} required />
          <select value={role} onChange={e => setRole(e.target.value as Role)}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <button>Add / update</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  )
}
