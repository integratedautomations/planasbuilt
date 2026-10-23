import { useSession } from '../settings/session'
import { switchable, showSwitcher } from './switcher'

/** Header control for people who work in more than one company (and platform admins). */
export function CompanySwitcher() {
  const session = useSession()
  if (!session) return null
  const { user, companies, switchCompany } = session
  if (!showSwitcher(user, companies)) return null
  const rows = switchable(user, companies)
  const active = user.company?.id ?? ''
  return (
    <select className="company-switcher" aria-label="Company" title="Switch company" value={active}
      onChange={e => { if (e.target.value && e.target.value !== active) void switchCompany(e.target.value) }}>
      {!rows.some(c => c.id === active) && <option value={active}>{user.company?.name ?? 'Choose a company'}</option>}
      {rows.map(c => <option key={c.id} value={c.id}>{c.name}{c.member ? '' : ' (not a member)'}</option>)}
    </select>
  )
}
