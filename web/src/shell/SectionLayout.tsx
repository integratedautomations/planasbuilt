import type { ReactNode } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { Icon } from '../ui/Icon'
import { PageShell } from './PageShell'
import type { Crumb } from './PageShell'

export interface SectionDef { id: string; label: string; element: ReactNode; hint?: string }

/** Which section a URL names. `undefined` = none given (desktop shows the first, phone shows the list); `null` = unknown. */
export function pickSection(ids: string[], urlSection: string | undefined): string | undefined | null {
  if (!urlSection) return undefined
  return ids.includes(urlSection) ? urlSection : null
}

/**
 * Account, Company admin and Platform: a section list on the left (desktop) that becomes list -> detail on a phone.
 * Sections are routes: `${base}/${id}`.
 */
export function SectionLayout({ base, title, crumbs, sections, width = 'wide' }: {
  base: string; title: string; crumbs: Crumb[]; sections: SectionDef[]; width?: 'default' | 'wide' | 'full'
}) {
  const url = useParams()['*']?.split('/')[0] || undefined
  const picked = pickSection(sections.map(s => s.id), url)
  if (picked === null) return <Navigate to={base} replace />
  const current = sections.find(s => s.id === (picked ?? sections[0].id))!
  return (
    <PageShell crumbs={crumbs} width={width}>
      <div className={`section-layout ${picked ? 'has-detail' : 'no-detail'}`}>
        <nav className="section-nav" aria-label={title}>
          {sections.map(s => (
            <NavLink key={s.id} to={`${base}/${s.id}`} className={() => (s.id === current.id ? 'active' : '')} aria-current={s.id === current.id && picked ? 'page' : undefined}>
              <span>{s.label}</span><span className="chev"><Icon name="chevron-right" size={16} /></span>
            </NavLink>
          ))}
        </nav>
        <div className="section-body">
          <NavLink to={base} className="section-back btn-link"><Icon name="arrow-left" size={16} /> {title}</NavLink>
          <h2 className="section-title">{current.label}</h2>
          {current.hint && <p className="muted small -mt">{current.hint}</p>}
          {current.element}
        </div>
      </div>
    </PageShell>
  )
}
