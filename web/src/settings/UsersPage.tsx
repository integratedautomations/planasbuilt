import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { LinkResult, ManagedUser, Role, User, UserStatus } from '../api'
import { Brand } from '../Brand'
import { OfflineBanner } from '../offline/OfflineBanner'
import { CopyLink } from './CopyLink'
import { UserMenu } from './UserMenu'

const STATUS_LABEL: Record<UserStatus, string> = { active: 'Active', invited: 'Invited', deactivated: 'Deactivated' }
type ProjectRef = { id: string; name: string }

function ago(iso: string | null) {
  if (!iso) return 'Never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'Just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`
  return new Date(iso).toLocaleDateString()
}

export function UsersPage({ me }: { me: User }) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null)
  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | UserStatus>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)

  const reload = () => api<ManagedUser[]>('/users').then(setUsers).catch(e => setError(e.message))
  useEffect(() => {
    void reload()
    api<ProjectRef[]>('/projects/all').then(setProjects).catch(() => {})
  }, [])

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return (users ?? []).filter(u => (status === 'all' || u.status === status) && (!n || u.name.toLowerCase().includes(n) || u.email.toLowerCase().includes(n)))
  }, [users, q, status])

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <span className="muted">/</span>
        <span className="crumb">Users</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content content-wide">
        <div className="row wrap">
          <h2>Users</h2>
          <span className="spacer" />
          <input type="search" placeholder="Search name or email" aria-label="Search users" value={q} onChange={e => setQ(e.target.value)} />
          <select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value as typeof status)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="deactivated">Deactivated</option>
          </select>
          <button className="primary" onClick={() => setInviting(true)}>Invite user</button>
        </div>
        {error && <div className="error">{error}</div>}
        {users === null ? <p className="muted">Loading…</p> : (
          <div className="table-wrap">
            <table className="data-table users-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th className="num">Projects</th><th>Last active</th><th>Status</th></tr></thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={6} className="muted">No users match.</td></tr>}
                {shown.map(u => (
                  <tr key={u.id} className={`clickable${openId === u.id ? ' selected' : ''}`} tabIndex={0}
                    onClick={() => setOpenId(u.id)} onKeyDown={e => { if (e.key === 'Enter') setOpenId(u.id) }}>
                    <td>{u.name}{u.id === me.id && <span className="muted small"> (you)</span>}</td>
                    <td>{u.email}</td>
                    <td>{u.is_admin ? 'Admin' : 'User'}</td>
                    <td className="num">{u.project_count}</td>
                    <td>{u.status === 'invited' ? '' : ago(u.last_seen_at)}</td>
                    <td><span className={`status-pill ${u.status}`}>{STATUS_LABEL[u.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
      {openId && <UserDrawer id={openId} me={me} projects={projects} onClose={() => setOpenId(null)} onChanged={reload} />}
      {inviting && <InviteDialog projects={projects} onClose={() => setInviting(false)} onDone={reload} />}
    </div>
  )
}

function UserDrawer({ id, me, projects, onClose, onChanged }: {
  id: string; me: User; projects: ProjectRef[]; onClose: () => void; onChanged: () => void
}) {
  const [u, setU] = useState<ManagedUser | null>(null)
  const [name, setName] = useState('')
  const [admin, setAdmin] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [link, setLink] = useState<LinkResult | null>(null)
  const [addId, setAddId] = useState('')
  const [addRole, setAddRole] = useState<Role>('editor')

  const apply = (next: ManagedUser) => { setU(next); setName(next.name); setAdmin(next.is_admin); onChanged() }
  useEffect(() => {
    setU(null); setLink(null); setError(''); setMsg('')
    api<ManagedUser>(`/users/${id}`).then(next => { setU(next); setName(next.name); setAdmin(next.is_admin) }).catch(e => setError(e.message))
  }, [id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError(''); setMsg('')
    try { return await fn() } catch (e) { setError((e as Error).message) }
  }

  const self = id === me.id
  const patch = (body: object) => run(async () => { apply(await api<ManagedUser>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) })); setMsg('Saved') })
  const setMembership = (project_id: string, role: Role | null) =>
    run(async () => { apply(await api<ManagedUser>(`/users/${id}/projects`, { method: 'PUT', body: JSON.stringify({ project_id, role }) })) })
  const showLink = (r?: LinkResult) => { if (r) { setLink(r); setMsg(r.emailed ? `Emailed to ${r.email}` : r.email_error ? `Email failed: ${r.email_error}` : '') } }

  const unassigned = projects.filter(p => !u?.projects?.some(m => m.id === p.id))

  function submit(e: FormEvent) {
    e.preventDefault()
    void patch({ name, is_admin: admin })
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="User details" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>{u?.name ?? 'User'}</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        {!u ? <p className="muted">{error || 'Loading…'}</p> : (
          <>
            <div className="muted small">{u.email} · <span className={`status-pill ${u.status}`}>{STATUS_LABEL[u.status]}</span>
              {u.status !== 'invited' && <> · last active {ago(u.last_seen_at)}</>}</div>

            <form className="stack" onSubmit={submit}>
              <label className="field">Name<input value={name} onChange={e => setName(e.target.value)} required /></label>
              <label className="field">Role
                <select value={admin ? 'admin' : 'user'} disabled={self} onChange={e => setAdmin(e.target.value === 'admin')}>
                  <option value="user">User</option>
                  <option value="admin">Admin (manages settings and users)</option>
                </select>
              </label>
              <div><button className="primary" disabled={name === u.name && admin === u.is_admin}>Save</button></div>
            </form>

            <h4>Projects</h4>
            {(u.projects ?? []).length === 0 && <p className="muted small">Not on any project yet.</p>}
            <ul className="list compact">
              {(u.projects ?? []).map(m => (
                <li key={m.id} className="list-item member-row">
                  <span className="grow">{m.name}</span>
                  <select value={m.role} aria-label={`Role on ${m.name}`} onChange={e => setMembership(m.id, e.target.value as Role)}>
                    <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option>
                  </select>
                  <button className="danger" onClick={() => setMembership(m.id, null)}>Remove</button>
                </li>
              ))}
            </ul>
            {unassigned.length > 0 && (
              <div className="row wrap">
                <select value={addId} aria-label="Add to project" onChange={e => setAddId(e.target.value)}>
                  <option value="">Add to a project…</option>
                  {unassigned.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={addRole} aria-label="Role" onChange={e => setAddRole(e.target.value as Role)}>
                  <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option>
                </select>
                <button disabled={!addId} onClick={async () => { await setMembership(addId, addRole); setAddId('') }}>Add</button>
              </div>
            )}

            <h4>Account</h4>
            <div className="row wrap">
              {u.status === 'invited' ? (
                <>
                  <button onClick={() => run(async () => showLink(await api<LinkResult>(`/users/${id}/invite`, { method: 'POST' })))}>Resend invite</button>
                  <button className="danger" onClick={() => {
                    if (confirm(`Revoke the invite for ${u.email}?`)) void run(async () => { await api(`/users/${id}/invite`, { method: 'DELETE' }); onChanged(); onClose() })
                  }}>Revoke invite</button>
                </>
              ) : (
                <>
                  <button onClick={() => run(async () => showLink(await api<LinkResult>(`/users/${id}/reset`, { method: 'POST' })))}>Reset password</button>
                  {u.status === 'active' && !self && (
                    <button className="danger" onClick={() => {
                      if (confirm(`Deactivate ${u.name}? They can no longer sign in. Their name stays on the markups they made.`)) void patch({ status: 'deactivated' })
                    }}>Deactivate</button>
                  )}
                  {u.status === 'deactivated' && <button onClick={() => patch({ status: 'active' })}>Reactivate</button>}
                </>
              )}
            </div>
            {link && (
              <CopyLink link={link.link} note={`Send this to ${link.email}. It works once and expires ${new Date(link.expires_at).toLocaleString()}.`} />
            )}
            {error && <div className="error">{error}</div>}
            {msg && <div className="muted small" role="status">{msg}</div>}
          </>
        )}
      </aside>
    </div>
  )
}

function InviteDialog({ projects, onClose, onDone }: { projects: ProjectRef[]; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [admin, setAdmin] = useState(false)
  const [picked, setPicked] = useState<Record<string, Role>>({})
  const [error, setError] = useState('')
  const [result, setResult] = useState<LinkResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const r = await api<LinkResult>('/invites', { method: 'POST', body: JSON.stringify({
        email, name, role: admin ? 'admin' : 'user', projects: Object.entries(picked).map(([id, role]) => ({ id, role })),
      }) })
      setResult(r); onDone()
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" role="dialog" aria-label="Invite user" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>Invite user</h3><span className="spacer" /><button onClick={onClose}>{result ? 'Done' : 'Cancel'}</button></div>
        {result ? (
          <>
            <p>{result.emailed ? `An email with the link was sent to ${result.email}. You can also copy it:` : `Copy this link and send it to ${result.email}:`}</p>
            {result.email_error && <div className="error">Email failed: {result.email_error}</div>}
            <CopyLink link={result.link} note={`Valid until ${new Date(result.expires_at).toLocaleString()}.`} />
          </>
        ) : (
          <form className="stack" onSubmit={submit}>
            <label className="field">Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></label>
            <label className="field">Name (optional)<input value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="check"><input type="checkbox" checked={admin} onChange={e => setAdmin(e.target.checked)} /> App admin (manages settings and users)</label>
            {projects.length > 0 && (
              <fieldset className="invite-projects">
                <legend className="small muted">Add to projects</legend>
                {projects.map(p => (
                  <div className="row" key={p.id}>
                    <label className="check grow"><input type="checkbox" checked={p.id in picked}
                      onChange={e => setPicked(cur => { const n = { ...cur }; if (e.target.checked) n[p.id] = 'editor'; else delete n[p.id]; return n })} /> {p.name}</label>
                    {p.id in picked && (
                      <select aria-label={`Role on ${p.name}`} value={picked[p.id]} onChange={e => setPicked(cur => ({ ...cur, [p.id]: e.target.value as Role }))}>
                        <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option>
                      </select>
                    )}
                  </div>
                ))}
              </fieldset>
            )}
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy}>Create invite</button>
          </form>
        )}
      </div>
    </div>
  )
}
