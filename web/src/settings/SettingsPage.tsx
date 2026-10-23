import { Link, useSearchParams } from 'react-router-dom'
import type { User } from '../api'
import { Brand } from '../Brand'
import { OfflineBanner } from '../offline/OfflineBanner'
import { CompanyTab } from './CompanyTab'
import { MailTab } from './MailTab'
import { OrganizationTab } from './OrganizationTab'
import { PersonalTab } from './PersonalTab'
import { StorageTab } from './StorageTab'
import { UserMenu } from './UserMenu'

const TABS = [
  { id: 'personal', label: 'Personal', admin: false },
  { id: 'company', label: 'Company', admin: true },
  { id: 'organization', label: 'Organization', admin: true },
  { id: 'storage', label: 'Storage', admin: true },
  { id: 'email', label: 'Email', admin: true },
]

export function SettingsPage({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const [params, setParams] = useSearchParams()
  const tabs = TABS.filter(t => !t.admin || user.is_admin)
  const tab = tabs.find(t => t.id === params.get('tab'))?.id ?? 'personal'
  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <span className="muted">/</span>
        <span className="crumb">Settings</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content content-wide settings-page">
        <h2>Settings</h2>
        <div className="tabs" role="tablist">
          {tabs.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setParams(t.id === 'personal' ? {} : { tab: t.id })}>{t.label}</button>
          ))}
        </div>
        {tab === 'personal' && <PersonalTab user={user} onUser={onUser} />}
        {tab === 'company' && <CompanyTab />}
        {tab === 'organization' && <OrganizationTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'email' && <MailTab />}
      </main>
    </div>
  )
}
