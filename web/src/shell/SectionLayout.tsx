import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import { PageShell } from './PageShell'
import type { Crumb } from './PageShell'

export interface SectionDef { id: string; label: string; element: ReactNode; hint?: string; icon?: IconName }

/** Which section a URL names. `undefined` = none given (desktop shows the first, phone shows the list); `null` = unknown. */
export function pickSection(ids: string[], urlSection: string | undefined): string | undefined | null {
  if (!urlSection) return undefined
  return ids.includes(urlSection) ? urlSection : null
}

/** The section shown for a URL: unknown -> redirect to the area root; none given -> the first (phones show it directly, no list step). */
export function resolveSection(ids: string[], urlSection: string | undefined): { current: string; redirect: boolean; explicit: boolean } {
  const picked = pickSection(ids, urlSection)
  if (picked === null) return { current: ids[0], redirect: true, explicit: false }
  return { current: picked ?? ids[0], redirect: false, explicit: !!picked }
}

/**
 * Account, Company admin and Platform: a section list on the left (desktop); on a phone a sticky scrollable tab strip with the section underneath.
 * Sections are routes: `${base}/${id}`.
 */
export function SectionLayout({ base, title, crumbs, sections, width = 'wide' }: {
  base: string; title: string; crumbs: Crumb[]; sections: SectionDef[]; width?: 'default' | 'wide' | 'full'
}) {
  const url = useParams()['*']?.split('/')[0] || undefined
  const stripRef = useRef<HTMLDivElement>(null)
  const r = resolveSection(sections.map(s => s.id), url)
  const current = sections.find(s => s.id === r.current)!
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('a.active')
    el?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  }, [r.current])
  if (r.redirect) return <Navigate to={base} replace />
  return (
    <PageShell crumbs={crumbs} width={width}>
      <div className="section-layout">
        <nav className="section-nav" aria-label={title}>
          {sections.map(s => (
            <NavLink key={s.id} to={`${base}/${s.id}`} className={s.id === current.id ? 'active' : ''} aria-current={s.id === current.id ? 'page' : undefined}>
              {s.icon && <Icon name={s.icon} size={18} />}<span>{s.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="section-tabs" ref={stripRef}>
          <nav className="section-tabstrip" aria-label={title}>
            {sections.map(s => (
              <NavLink key={s.id} to={`${base}/${s.id}`} replace className={s.id === current.id ? 'active' : ''} aria-current={s.id === current.id ? 'page' : undefined}>
                {s.icon && <Icon name={s.icon} size={16} />}<span>{s.label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="section-body">
          <h2 className="section-title">{current.icon && <Icon name={current.icon} size={20} />}{current.label}</h2>
          {current.hint && <p className="muted small -mt">{current.hint}</p>}
          {current.element}
        </div>
      </div>
    </PageShell>
  )
}
