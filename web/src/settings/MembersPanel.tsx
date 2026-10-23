import { FormEvent, useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { LinkResult, Member, Role, User } from '../api'
import { EMPTY_SCOPE, ROLE_INFO } from '../roles'
import type { Scope } from '../roles'
import { CopyLink } from './CopyLink'
import { RoleSelect, ScopePicker } from './RoleSelect'

type Row = Member & { status?: string }
type Person = { id: string; email: string; name: string }

/** Members tab of a project: roles, add an existing user, invite someone new, remove. */
export function MembersPanel({ projectId, canManage, me }: { projectId: string; canManage: boolean; me: User }) {
  const [members, setMembers] = useState<Row[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState('')
  const [pick, setPick] = useState('')
  const [pickRole, setPickRole] = useState<Role>('editor')
  const [pickScope, setPickScope] = useState<Scope>(EMPTY_SCOPE)
  /** Member whose subcontractor scope is being edited, with the draft. */
  const [scopeOf, setScopeOf] = useState<{ id: string; scope: Scope } | null>(null)
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
  const saveScope = (m: Row, scope: Scope) =>
    run(async () => { await api(`/projects/${projectId}/members`, { method: 'PUT', body: JSON.stringify({ email: m.email, role: m.role, scope }) }); setScopeOf(null) })
  const remove = (m: Row) => {
    if (confirm(`Remove ${m.name} from this project?`)) void run(() => api(`/projects/${projectId}/members/${m.id}`, { method: 'DELETE' }))
  }
  const addExisting = (e: FormEvent) => {
    e.preventDefault()
    const p = people.find(x => x.id === pick)
    if (!p) return
    void run(async () => {
      await api(`/projects/${projectId}/members`, { method: 'PUT', body: JSON.stringify({ email: p.email, role: pickRole, ...(pickRole === 'sub' ? { scope: pickScope } : {}) }) })
      setPick(''); setPickScope(EMPTY_SCOPE)
    })
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
                    <>
                      <RoleSelect value={m.role} label={`Role of ${m.name}`} describe={false} onChange={r => setRole(m, r)} />
                      {m.role === 'sub' && (
                        <button className="link-btn" onClick={() => setScopeOf(scopeOf?.id === m.id ? null : { id: m.id, scope: m.scope ?? EMPTY_SCOPE })}>
                          {' '}Scope ({(m.scope?.sets.length ?? 0) + (m.scope?.layers.length ?? 0)})
                        </button>
                      )}
                      {scopeOf?.id === m.id && (
                        <div className="card">
                          <ScopePicker projectId={projectId} value={scopeOf.scope} onChange={scope => setScopeOf({ id: m.id, scope })} />
                          <div className="row"><button className="primary" onClick={() => saveScope(m, scopeOf.scope)}>Save scope</button><button onClick={() => setScopeOf(null)}>Cancel</button></div>
                        </div>
                      )}
                    </>
                  ) : ROLE_INFO[m.role]?.label ?? m.role}
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
              <RoleSelect value={pickRole} onChange={setPickRole} />
              <button disabled={!pick}>Add</button>
            </div>
            {pickRole === 'sub' && <ScopePicker projectId={projectId} value={pickScope} onChange={setPickScope} />}
          </form>
          <form className="card settings-card" onSubmit={sendInvite}>
            <h4>Invite someone new</h4>
            <div className="row wrap">
              <input type="email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)} required />
              <RoleSelect value={inviteRole} onChange={setInviteRole} />
              <button className="primary">Create invite</button>
            </div>
            {inviteRole === 'sub' && <p className="muted small">Choose what this subcontractor can see with the Scope button once they appear in the list.</p>}
            {invite && (
              <>
                {invite.emailed && <p className="muted small">Emailed to {invite.email}.</p>}
                {invite.email_error && <div className="error">Email failed: {invite.email_error}</div>}
                {invite.link
                  ? <CopyLink link={invite.link} note={`Send this to ${invite.email}. Valid until ${invite.expires_at ? new Date(invite.expires_at).toLocaleDateString() : 'used'}.`} />
                  : <p className="muted small" role="status">{invite.emailed ? 'Invitation sent.' : `Invitation created for ${invite.email}. If they don't get an email, a company admin can resend it from Company members.`}</p>}
              </>
            )}
          </form>
        </div>
      )}
    </section>
  )
}
