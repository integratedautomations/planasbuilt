import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { legacyRedirect, projectTabs } from './projectTabs'
import { ProjectTabs } from './ProjectShell'
import { pickSection } from './SectionLayout'
import { pathAfterSwitch } from '../company/switcher'
import { shouldAdoptOwner } from '../company/activeCompany'
import { DEFAULT_LAYOUT } from '../prefs/layout'

describe('legacy routes', () => {
  it('sends old Settings tabs to the new Account / Company admin sections', () => {
    expect(legacyRedirect('/settings')).toBe('/account/profile')
    expect(legacyRedirect('/settings', '?tab=personal')).toBe('/account/profile')
    expect(legacyRedirect('/settings', '?tab=company')).toBe('/company/profile')
    expect(legacyRedirect('/settings', '?tab=organization')).toBe('/company/profile')
    expect(legacyRedirect('/settings', '?tab=storage')).toBe('/company/storage')
    expect(legacyRedirect('/settings', '?tab=email')).toBe('/company/email')
  })
  it('moves the other old pages', () => {
    expect(legacyRedirect('/preferences')).toBe('/account/preferences')
    expect(legacyRedirect('/users')).toBe('/company/members')
    expect(legacyRedirect('/catalog')).toBe('/company/catalog')
    expect(legacyRedirect('/symbols')).toBe('/company/catalog')
    expect(legacyRedirect('/backups/')).toBe('/company/backups')
    expect(legacyRedirect('/companies')).toBe('/platform/companies')
  })
  it('leaves current routes alone', () => {
    expect(legacyRedirect('/account/profile')).toBeNull()
    expect(legacyRedirect('/projects/p1/devices')).toBeNull()
    expect(legacyRedirect('/')).toBeNull()
  })
  it('company switch still resets company-scoped pages', () => {
    expect(pathAfterSwitch('/company/members')).toBe('/')
    expect(pathAfterSwitch('/company/profile')).toBe('/company/profile')
    expect(pathAfterSwitch('/account/profile')).toBe('/account/profile')
  })
})

describe('project tabs', () => {
  it('are real routes in a fixed order', () => {
    const t = projectTabs('p1', { canManage: true })
    expect(t.map(x => x.label)).toEqual(['Plans', 'Devices', 'Wiring', 'BOM', 'Members', 'Settings'])
    expect(t.map(x => x.to)).toEqual(['/projects/p1', '/projects/p1/devices', '/projects/p1/wiring', '/projects/p1/bom', '/projects/p1/members', '/projects/p1/settings'])
  })
  it('hide Settings from non-admins, show it to platform admins, and call BOM "Parts" without cost access', () => {
    expect(projectTabs('p1', { canManage: false }).map(x => x.id)).not.toContain('settings')
    expect(projectTabs('p1', { canManage: false, platformAdmin: true }).map(x => x.id)).toContain('settings')
    expect(projectTabs('p1', { canManage: false, canSeeCosts: false }).find(x => x.id === 'bom')?.label).toBe('Parts')
  })
  it('render as links with the current one marked', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/projects/p1/wiring']}><ProjectTabs projectId="p1" canManage /></MemoryRouter>)
    expect(html).toContain('href="/projects/p1/devices"')
    expect(html).toContain('href="/projects/p1/settings"')
    expect(html).toMatch(/class="tab active"[^>]*href="\/projects\/p1\/wiring"|href="\/projects\/p1\/wiring"[^>]*class="tab active"/)
    expect(html).not.toMatch(/class="tab active"[^>]*href="\/projects\/p1"[ >]/)
  })
})

describe('section pages', () => {
  it('pick a section from the URL', () => {
    const ids = ['profile', 'preferences']
    expect(pickSection(ids, undefined)).toBeUndefined()
    expect(pickSection(ids, 'preferences')).toBe('preferences')
    expect(pickSection(ids, 'nope')).toBeNull()
  })
})

describe('viewer defaults', () => {
  it('opens with the Pages dock closed', () => {
    expect(DEFAULT_LAYOUT.panels.pages.open).toBe(false)
  })
})

describe('company switch from a project page', () => {
  it('a project answer from before the switch cannot pull the app back', () => {
    // started in A, user switched to B, the old project (owner A) answers late
    expect(shouldAdoptOwner('A', 'B', 'A')).toBe(false)
    // opening a project of another company directly still follows it
    expect(shouldAdoptOwner('A', 'A', 'B')).toBe(true)
    expect(shouldAdoptOwner('A', 'A', 'A')).toBe(false)
  })
})
