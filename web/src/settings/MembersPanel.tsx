import { FormEvent, useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { LinkResult, Member, Role, User } from '../api'
import { CopyLink } from './CopyLink'

type Row = Member & { status?: string }
type Person = { id: string; email: string; name: string }

/** Members tab of a project: roles, add an existing user, invite someone new, remove. */
export function MembersPanel({ projectId, canManage, me }: { projectId: string; canManage: boolean; me: User }) {
  const [members, setMembers] = useState<Row[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState('')
  const [pick, setPick] = useState('')
  const [pickRole, setPickRole] = useState<Role>('editor')
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('editor')
  const [invite, setInvite] = useState<LinkResult | null>(null)

  const reload = useCallback(() => api<Row[]>(`/projects/${projectId}/members`).then(setMembers).catch(e => setError(e.message)), [projectId])
  useEffect(() => {
    void reload()
    if (canManage) api<Person[]>('/users/directory').then(setPeople).catch(() => {})
  }, [reload, canManage])

  async function run(fn: () => Promise<unknown>) {
    setError('')
    try { await fn(); await reload() } catch (e) { setError((e as Error).message) }
  }

  const setRole = (m: Row, role: Role) =>
    run(() => api(`/projects/${projectId}/members`, { method: 'PUT', body: JSON.stringify({ email: m.email, role }) }))
  const remove = (m: Row) => {
    if (confirm(`Remove ${m.name} from this project?`)) void run(() => api(`/projects/${projectId}/members/${m.id}`, { method: 'DELETE' }))
  }
  const addExisting = (e: FormEvent) => {
    e.preventDefault()
    const p = people.find(x => x.id === pick)
    if (!p) return
    void run(async () => { await api(`/projects/${projectId}/members`, { method: 'PUT', body: JSON.stringify({ email: p.email, role: pickRole }) }); setPick('') })
  }
  const sendInvite = (e: FormEvent) => {
    e.preventDefault(); setInvite(null)
    void run(async () => {
      setInvite(await api<LinkResult>(`/projects/${projectId}/invites`, { method: 'POST', body: JSON.stringify({ email, role: inviteRole }) }))
      setEmail('')
    })
  }

  const available = people.filter(p => !members.some(m => m.id === p.id))

  return (
    <section className="members-panel">
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th>{canManage && <th />}</tr></thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td>{m.name}{m.id === me.id && <span className="muted small"> (you)</span>}</td>
                <td>{m.email}{m.status === 'invited' && <span className="status-pill invited">Invited</span>}</td>
                <td>
                  {canManage ? (
                    <select value={m.role} aria-label={`Role of ${m.name}`} onChange={e => setRole(m, e.target.value as Role)}>
                      <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option>
                    </select>
                  ) : m.role}
                </td>
                {canManage && <td className="num"><button className="danger" onClick={() => remove(m)}>Remove</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="error">{error}</div>}
      {canManage && (
        <div className="settings-grid">
          <form className="card settings-card" onSubmit={addExisting}>
            <h4>Add an existing user</h4>
            <div className="row wrap">
              <select value={pick} aria-label="User to add" onChange={e => setPick(e.target.value)}>
                <option value="">Choose a person…</option>
                {available.map(p => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
              </select>
              <select value={pickRole} aria-label="Role" onChange={e => setPickRole(e.target.value as Role)}>
                <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option>
              </select>
              <button disabled={!pick}>Add</button>
            </div>
          </form>
          <form className="card settings-card" onSubmit={sendInvite}>
            <h4>Invite someone new</h4>
            <div className="row wrap">
              <input type="email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)} required />
              <select value={inviteRole} aria-label="Role" onChange={e => setInviteRole(e.target.value as Role)}>
                <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option>
              </select>
              <button className="primary">Create invite</button>
            </div>
            {invite && (
              <>
                {invite.emailed && <p className="muted small">Emailed to {invite.email}.</p>}
                {invite.email_error && <div className="error">Email failed: {invite.email_error}</div>}
                <CopyLink link={invite.link} note={`Send this to ${invite.email}. Valid until ${new Date(invite.expires_at).toLocaleDateString()}.`} />
              </>
            )}
          </form>
        </div>
      )}
    </section>
  )
}
