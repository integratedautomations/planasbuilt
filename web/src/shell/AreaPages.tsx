import type { User } from '../api'
import { CatalogPanel } from '../pages/SymbolSetsPage'
import { BackupsPanel } from '../settings/BackupsPage'
import { CompaniesPanel } from '../settings/CompaniesPage'
import { CompanyTab } from '../settings/CompanyTab'
import { MailTab } from '../settings/MailTab'
import { NotificationsPanel, PreferencesPanel } from '../settings/PreferencesPage'
import { PersonalTab } from '../settings/PersonalTab'
import { SecurityPanel } from '../settings/SecurityPanel'
import { StorageTab } from '../settings/StorageTab'
import { UsersPanel } from '../settings/UsersPage'
import { SectionLayout } from './SectionLayout'
import type { SectionDef } from './SectionLayout'

/** /account/*: Profile, Preferences, Notifications. */
export function AccountPage({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const sections: SectionDef[] = [
    { id: 'profile', label: 'Profile', hint: 'Your name, picture and password.', element: <PersonalTab user={user} onUser={onUser} /> },
    { id: 'preferences', label: 'Preferences', hint: 'These follow you to every device you sign in on.', element: <PreferencesPanel /> },
    { id: 'notifications', label: 'Notifications', element: <NotificationsPanel /> },
  ]
  return <SectionLayout base="/account" title="Account" crumbs={[{ label: 'Projects', to: '/' }, { label: 'Account' }]} sections={sections} />
}

/** /company/*: for company owners and admins. Non-admins only reach the read-only catalog. */
export function CompanyAdminPage({ user }: { user: User }) {
  const company = user.company?.name
  const admin = !!user.is_admin
  const sections: SectionDef[] = [
    ...(admin ? [
      { id: 'profile', label: 'Profile & branding', hint: company ? `Settings for ${company}. Use the company switcher in the header to change another company.` : undefined, element: <CompanyTab /> },
      { id: 'members', label: 'Members', element: <UsersPanel me={user} /> },
    ] : []),
    { id: 'catalog', label: 'Catalog', element: <CatalogPanel user={user} /> },
    ...(admin ? [
      { id: 'storage', label: 'Storage & files', element: <StorageTab /> },
      { id: 'email', label: 'Email', element: <MailTab /> },
      { id: 'backups', label: 'Backups', element: <BackupsPanel scope="company" /> },
    ] : []),
  ]
  return <SectionLayout base="/company" title={admin ? 'Company admin' : 'Catalog'} crumbs={[{ label: 'Projects', to: '/' }, { label: admin ? 'Company admin' : 'Catalog' }]} sections={sections} width="wide" />
}

/** /platform/*: platform admins only. */
export function PlatformPage() {
  const sections: SectionDef[] = [
    { id: 'companies', label: 'Companies', element: <CompaniesPanel /> },
    { id: 'security', label: 'Security', element: <SecurityPanel /> },
    { id: 'backups', label: 'Server backups', element: <BackupsPanel scope="system" /> },
  ]
  return <SectionLayout base="/platform" title="Platform" crumbs={[{ label: 'Projects', to: '/' }, { label: 'Platform' }]} sections={sections} />
}
