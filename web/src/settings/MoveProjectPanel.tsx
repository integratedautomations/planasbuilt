import { useEffect, useState } from 'react'
import type { Project } from '../api'
import { describeMove, listCompanies, moveProject } from '../company/api'
import type { CompanyRow, MoveResult } from '../company/api'
import { useSession } from './session'

/** Platform admins: move this project (and the catalog entries it uses) to another company. */
export function MoveProjectPanel({ project, onMoved }: { project: Project; onMoved?: (companyId: string) => void }) {
  const session = useSession()
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<MoveResult | null>(null)
  useEffect(() => { listCompanies().then(setCompanies).catch(e => setError(e.message)) }, [])
  const options = companies.filter(c => !c.archived && c.id !== project.company_id)
  async function move() {
    const to = options.find(c => c.id === target)
    if (!to || !confirm(`Move "${project.name}" to ${to.name}? Its device types and products are matched by name or copied into ${to.name}.`)) return
    setError(''); setResult(null); setBusy(true)
    try { setResult(await moveProject(project.id, to.id)); onMoved?.(to.id); void session?.refreshCompanies() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <section className="card settings-card">
      <h4>Move project to another company</h4>
      <p className="muted small">The project, its plans and photos move together. Catalog entries it uses are matched by name in the other company, or copied there when missing.</p>
      <div className="row wrap">
        <select value={target} aria-label="Company to move to" onChange={e => setTarget(e.target.value)}>
          <option value="">Choose a company…</option>
          {options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="danger" disabled={!target || busy} onClick={move}>{busy ? 'Moving…' : 'Move project'}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div role="status">
          <strong>Moved.</strong>
          <ul className="small">{describeMove(result).map(l => <li key={l}>{l}</li>)}</ul>
        </div>
      )}
    </section>
  )
}
