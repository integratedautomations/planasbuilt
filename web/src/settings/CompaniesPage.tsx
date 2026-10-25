import { FormEvent, useCallback, useEffect, useState } from 'react'
import { COMPANY_ROLES, COMPANY_ROLE_INFO } from '../roles'
import type { CompanyRole } from '../roles'
import { createCompany, listCompanies, listMembers, patchCompany, patchMember, putMember, removeMember } from '../company/api'
import type { CompanyMember, CompanyRow } from '../company/api'
import { useSession } from './session'
import { useConfirm } from '../ui/ConfirmDialog'

/** Platform admins: every company, create / rename / archive, and who belongs to each. */
export function CompaniesPanel() {
  const session = useSession()
  const [rows, setRows] = useState<CompanyRow[] | null>(null)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [seed, setSeed] = useState(true)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try { setRows(await listCompanies({ includeArchived: true })); void session?.refreshCompanies() } catch (e) { setError((e as Error).message) }
  }, [session])
  useEffect(() => { void reload() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const c = await createCompany({ name, ...(ownerEmail.trim() ? { owner_email: ownerEmail.trim() } : {}), seed_catalog: seed })
      setName(''); setOwnerEmail(''); await reload(); setOpenId(c.id)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const shown = (rows ?? []).filter(c => showArchived || !c.archived)
  return (
    <div className="panel">
      <div className="panel-main">
        <div className="row wrap">
          <h2>Companies</h2>
          <span className="spacer" />
          <label className="check"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived</label>
        </div>
        <form className="card settings-card" onSubmit={create}>
          <h4>New company</h4>
          <div className="row wrap">
            <input placeholder="Company name" aria-label="Company name" value={name} onChange={e => setName(e.target.value)} required />
            <input type="email" placeholder="Owner email (optional)" aria-label="Owner email" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} />
            <label className="check"><input type="checkbox" checked={seed} onChange={e => setSeed(e.target.checked)} /> Start with the standard catalog</label>
            <button className="primary" disabled={busy}>Create company</button>
          </div>
        </form>
        {error && <div className="error">{error}</div>}
        {rows === null ? <p className="muted">Loading…</p> : (
          <ul className="list">
            {shown.length === 0 && <li className="muted">No companies.</li>}
            {shown.map(c => (
              <li key={c.id}>
                <CompanyCard c={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} onChanged={reload} onError={setError} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function CompanyCard({ c, open, onToggle, onChanged, onError }: {
  c: CompanyRow; open: boolean; onToggle: () => void; onChanged: () => Promise<void>; onError: (m: string) => void
}) {
  const [name, setName] = useState(c.name)
  useEffect(() => setName(c.name), [c.name])
  const run = async (fn: () => Promise<unknown>) => { onError(''); try { await fn(); await onChanged() } catch (e) { onError((e as Error).message) } }
  return (
    <div className="card">
      <div className="row wrap">
        <button type="button" className="link-btn" aria-expanded={open} onClick={onToggle}><strong>{c.name}</strong></button>
        {c.archived && <span className="status-pill deactivated">Archived</span>}
        {c.active && <span className="status-pill active">Current</span>}
        {c.member_count !== undefined && <span className="muted small">{c.member_count} member{c.member_count === 1 ? '' : 's'}</span>}
        <span className="spacer" />
        <button onClick={() => run(() => patchCompany(c.id, { archived: !c.archived }))}>{c.archived ? 'Restore' : 'Archive'}</button>
      </div>
      {open && (
        <div className="stack">
          <form className="row wrap" onSubmit={e => { e.preventDefault(); void run(() => patchCompany(c.id, { name })) }}>
            <input value={name} aria-label="Company name" onChange={e => setName(e.target.value)} required />
            <button disabled={!name.trim() || name === c.name}>Rename</button>
          </form>
          <CompanyMembers companyId={c.id} onError={onError} onChanged={onChanged} />
        </div>
      )}
    </div>
  )
}

function CompanyMembers({ companyId, onError, onChanged }: { companyId: string; onError: (m: string) => void; onChanged: () => Promise<void> }) {
  const [members, setMembers] = useState<CompanyMember[] | null>(null)
  const { ask, dialog } = useConfirm()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<CompanyRole>('member')
  const [canCreate, setCanCreate] = useState(false)
  const load = useCallback(() => listMembers(companyId).then(setMembers).catch(e => onError(e.message)), [companyId, onError])
  useEffect(() => { void load() }, [load])
  const run = async (fn: () => Promise<unknown>) => { onError(''); try { await fn(); await load(); void onChanged() } catch (e) { onError((e as Error).message) } }

  return (
    <div>
      {dialog}
      <h4>Members</h4>
      {members === null ? <p className="muted">Loading…</p> : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Can create projects</th><th /></tr></thead>
            <tbody>
              {members.length === 0 && <tr><td colSpan={5} className="muted">No members.</td></tr>}
              {members.map(m => (
                <tr key={m.user_id}>
                  <td>{m.name}{m.platform_admin && <span className="muted small"> (platform admin)</span>}</td>
                  <td>{m.email}</td>
                  <td>
                    <select value={m.role} aria-label={`Role of ${m.name}`} onChange={e => run(() => patchMember(companyId, m.user_id, { role: e.target.value as CompanyRole }))}>
                      {COMPANY_ROLES.map(r => <option key={r} value={r}>{COMPANY_ROLE_INFO[r].label}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`${m.name} can create projects`} checked={m.can_create_projects || m.role === 'owner' || m.role === 'admin'}
                      disabled={m.role === 'owner' || m.role === 'admin' || m.role === 'guest'}
                      onChange={e => run(() => patchMember(companyId, m.user_id, { can_create_projects: e.target.checked }))} />
                  </td>
                  <td className="num">
                    <button className="danger" onClick={async () => { if (await ask(`Remove ${m.name} from this company?`, 'Remove')) void run(() => removeMember(companyId, m.user_id)) }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="row wrap" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(async () => { await putMember(companyId, { email: email.trim(), role, can_create_projects: canCreate }); setEmail('') }) }}>
        <input type="email" placeholder="Add by email (existing account)" aria-label="Email to add" value={email} onChange={e => setEmail(e.target.value)} required />
        <select value={role} aria-label="Role" onChange={e => setRole(e.target.value as CompanyRole)}>
          {COMPANY_ROLES.map(r => <option key={r} value={r}>{COMPANY_ROLE_INFO[r].label}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={canCreate} onChange={e => setCanCreate(e.target.checked)} /> Can create projects</label>
        <button>Add member</button>
      </form>
    </div>
  )
}
