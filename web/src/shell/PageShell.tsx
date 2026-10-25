import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Brand } from '../Brand'
import { CompanySwitcher } from '../company/CompanySwitcher'
import { OfflineBanner } from '../offline/OfflineBanner'
import { UserMenu } from '../settings/UserMenu'
import { Icon } from '../ui/Icon'
import './shell.css'

export interface Crumb { label: string; to?: string }
export type ContentWidth = 'default' | 'wide' | 'full'

/**
 * The chrome every non-viewer page shares: brand, company switcher, a breadcrumb trail with a back link, optional header
 * actions and the avatar menu. `width` picks the content column: default 860, wide 1100, full = fills the screen (tables).
 */
export function PageShell({ crumbs = [], actions, width = 'default', className = '', children, below }: {
  crumbs?: Crumb[]; actions?: ReactNode; width?: ContentWidth; className?: string; children: ReactNode
  /** Rendered between the header and the content column (the project tab strip). */
  below?: ReactNode
}) {
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : crumbs.length === 1 ? { label: 'Projects', to: '/' } : null
  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <CompanySwitcher />
        {parent?.to && <Link to={parent.to} className="crumb-back" aria-label={`Back to ${parent.label}`} title={`Back to ${parent.label}`}><Icon name="arrow-left" size={18} /></Link>}
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={i} className={`crumb-item${last ? ' current' : ''}`}>
                {i > 0 && <span className="muted crumb-sep">/</span>}
                {c.to && !last ? <Link to={c.to} className="crumb">{c.label}</Link> : <span className="crumb" title={c.label} aria-current={last ? 'page' : undefined}>{c.label}</span>}
              </span>
            )
          })}
        </nav>
        <span className="spacer" />
        {actions}
        <UserMenu />
      </header>
      <OfflineBanner />
      {below}
      <main className={`content content-${width} ${className}`.trim()}>{children}</main>
    </div>
  )
}
