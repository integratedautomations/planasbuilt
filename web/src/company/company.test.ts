import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, authFetch, companyLogoUrl } from '../api'
import { getActiveCompanyId, resetActiveCompanyForTests, setActiveCompanyId, subscribeActiveCompany } from './activeCompany'
import { describeMove } from './api'
import { pageBelongsToCompany, pathAfterSwitch, pickInitialCompany, showSwitcher, switchable } from './switcher'
import type { CompanyRow } from './switcher'
import { db } from '../offline/db'
import { inScope, readScoped, replaceScoped, stamp } from '../offline/companyScope'
import { canCreateProjectsIn, companyRoleAtLeast, isCompanyAdmin, isCompanyRole } from '../roles'

let store: Record<string, string>
let calls: { url: string; headers: Headers }[]

beforeEach(async () => {
  store = {}
  calls = []
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
  resetActiveCompanyForTests()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => { vi.unstubAllGlobals(); resetActiveCompanyForTests() })

describe('X-Company-Id header', () => {
  it('is sent on api() and authFetch() once a company is active', async () => {
    setActiveCompanyId('c1')
    await api('/projects')
    await authFetch('/api/documents/d/file')
    expect(calls.map(c => c.headers.get('X-Company-Id'))).toEqual(['c1', 'c1'])
  })
  it('is left off when no company is chosen, and follows a switch', async () => {
    await api('/me')
    setActiveCompanyId('c2')
    await api('/projects')
    setActiveCompanyId('c3')
    await api('/projects')
    expect(calls.map(c => c.headers.get('X-Company-Id'))).toEqual([null, 'c2', 'c3'])
  })
  it('does not override a header the caller set', async () => {
    setActiveCompanyId('c1')
    await api('/x', { headers: { 'X-Company-Id': 'other' } })
    expect(calls[0].headers.get('X-Company-Id')).toBe('other')
  })
  it('is remembered on the device and announced to subscribers', () => {
    const seen: (string | null)[] = []
    subscribeActiveCompany(id => seen.push(id))
    setActiveCompanyId('c9')
    setActiveCompanyId('c9')
    expect(store['planmark.activeCompany']).toBe('c9')
    expect(seen).toEqual(['c9'])
    resetActiveCompanyForTests()
    expect(getActiveCompanyId()).toBe('c9')
  })
  it('puts ?company= on file URLs that cannot carry headers', () => {
    expect(companyLogoUrl()).toBe('/api/company/logo')
    setActiveCompanyId('c1')
    expect(companyLogoUrl()).toBe('/api/company/logo?company=c1')
    expect(companyLogoUrl(3)).toBe('/api/company/logo?v=3&company=c1')
  })
})

describe('offline cache scoped by company', () => {
  const p = (id: string, company_id?: string) => ({ id, name: id, created_at: '', role: 'admin' as const, company_id })

  it('stamps rows and only returns the active company', async () => {
    expect(stamp([p('a'), p('b', 'c2')], 'c1').map(r => r.company_id)).toEqual(['c1', 'c2'])
    expect(inScope([p('a', 'c1'), p('b', 'c2'), p('legacy')], 'c1').map(r => r.id)).toEqual(['a'])
  })

  it('a refresh replaces only that company\'s rows', async () => {
    await replaceScoped(db.projects, [p('a1'), p('a2')], 'c1')
    await replaceScoped(db.projects, [p('b1')], 'c2')
    expect((await readScoped(db.projects, 'c1')).map(r => r.id).sort()).toEqual(['a1', 'a2'])
    expect((await readScoped(db.projects, 'c2')).map(r => r.id)).toEqual(['b1'])
    await replaceScoped(db.projects, [p('a3')], 'c1')
    expect((await readScoped(db.projects, 'c1')).map(r => r.id)).toEqual(['a3'])
    expect((await readScoped(db.projects, 'c2')).map(r => r.id)).toEqual(['b1'])
  })

  it('rows cached before scoping existed are dropped by the next refresh and never shown', async () => {
    await db.symbolSets.put({ id: 'old', name: 'Old', color: '', tag_prefix: '', sort: 0 } as any)
    expect(await readScoped(db.symbolSets, 'c1')).toEqual([])
    await replaceScoped(db.symbolSets, [{ id: 'new', name: 'New', color: '', tag_prefix: '', sort: 0 } as any], 'c1')
    expect((await db.symbolSets.toArray()).map(r => r.id)).toEqual(['new'])
  })

  it('loaders read the active company\'s catalog when offline', async () => {
    const { loadCatalog } = await import('../offline/cache')
    const { cacheAllowed } = await import('../offline/cacheOwner')
    const { claimCache } = await import('../offline/cacheOwner')
    await claimCache('u1')
    expect(await cacheAllowed()).toBe(true)
    const dt = (id: string) => ({ id, symbol_set_id: 's', name: id } as any)
    const catalog = (id: string) => ({ device_types: [dt(id)], products: [], cable_types: [] })
    const online = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    const offline = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    setActiveCompanyId('c1'); online(catalog('t-c1')); await loadCatalog()
    setActiveCompanyId('c2'); online(catalog('t-c2')); await loadCatalog()

    offline()
    setActiveCompanyId('c1')
    expect((await loadCatalog()).data.device_types.map(t => t.id)).toEqual(['t-c1'])
    setActiveCompanyId('c2')
    expect((await loadCatalog()).data.device_types.map(t => t.id)).toEqual(['t-c2'])
    setActiveCompanyId('c3')
    await expect(loadCatalog()).rejects.toThrow()
  })
})

describe('switcher logic', () => {
  const row = (id: string, name: string, over: Partial<CompanyRow> = {}): CompanyRow =>
    ({ id, name, archived: false, role: 'member', member: true, ...over })

  it('shows only with more than one company, or for platform admins', () => {
    expect(showSwitcher({}, [row('a', 'A')])).toBe(false)
    expect(showSwitcher({}, [row('a', 'A'), row('b', 'B')])).toBe(true)
    expect(showSwitcher({}, [row('a', 'A'), row('b', 'B', { archived: true })])).toBe(false)
    expect(showSwitcher({}, [row('a', 'A'), row('b', 'B', { member: false })])).toBe(false)
    expect(showSwitcher({ platform_admin: true }, [row('a', 'A')])).toBe(true)
    expect(showSwitcher(null, [row('a', 'A'), row('b', 'B')])).toBe(false)
  })
  it('lists member companies by name; platform admins also get the ones they are not in', () => {
    const rows = [row('b', 'Beta'), row('a', 'Alpha'), row('c', 'Gamma', { member: false }), row('d', 'Old', { archived: true })]
    expect(switchable({}, rows).map(c => c.id)).toEqual(['a', 'b'])
    expect(switchable({ platform_admin: true }, rows).map(c => c.id)).toEqual(['a', 'b', 'c'])
  })
  it('starts in the remembered company when still usable', () => {
    expect(pickInitialCompany('b', 'a', ['a', 'b'])).toBe('b')
    expect(pickInitialCompany('gone', 'a', ['a', 'b'])).toBe('a')
    expect(pickInitialCompany(null, 'zzz', ['a', 'b'])).toBe('a')
    expect(pickInitialCompany(null, null, [])).toBeNull()
  })
  it('sends company-bound pages back to the project list after a switch', () => {
    expect(pageBelongsToCompany('/projects/p1')).toBe(true)
    expect(pageBelongsToCompany('/projects/p1/documents/d1')).toBe(true)
    expect(pathAfterSwitch('/projects/p1/bom')).toBe('/')
    expect(pathAfterSwitch('/users')).toBe('/')
    expect(pathAfterSwitch('/settings')).toBe('/settings')
    expect(pathAfterSwitch('/symbols')).toBe('/symbols')
    expect(pathAfterSwitch('/companies')).toBe('/companies')
    expect(pathAfterSwitch('/')).toBe('/')
  })
})

describe('company roles', () => {
  it('orders roles and finds admins', () => {
    expect(isCompanyRole('owner')).toBe(true)
    expect(isCompanyRole('pm')).toBe(false)
    expect(companyRoleAtLeast('admin', 'member')).toBe(true)
    expect(companyRoleAtLeast('member', 'admin')).toBe(false)
    expect(companyRoleAtLeast(null, 'guest')).toBe(false)
    expect(isCompanyAdmin('owner')).toBe(true)
    expect(isCompanyAdmin('member')).toBe(false)
  })
  it('lets admins always create projects, members when granted, guests never', () => {
    expect(canCreateProjectsIn('owner', false)).toBe(true)
    expect(canCreateProjectsIn('admin', undefined)).toBe(true)
    expect(canCreateProjectsIn('member', true)).toBe(true)
    expect(canCreateProjectsIn('member', false)).toBe(false)
    expect(canCreateProjectsIn('guest', true)).toBe(false)
    expect(canCreateProjectsIn(null, true)).toBe(false)
  })
})

describe('describeMove', () => {
  it('summarizes the result of moving a project', () => {
    expect(describeMove({ ok: true, symbol_sets: { matched: 2, copied: 1 }, products: { matched: 0, copied: 4 }, members_added: 1 })).toEqual([
      '2 symbol sets matched, 1 copied', '0 products matched, 4 copied', '1 member added to the new company',
    ])
  })
})

describe('outbox replay', () => {
  it('replays by document, whichever company is active when it drains', async () => {
    const { configure, drain, queueMarkupDelete, resetSyncState, setSyncUser } = await import('../offline/sync')
    resetSyncState(); configure({ autoRetry: false })
    setSyncUser({ id: 'u1', name: 'U' })
    setActiveCompanyId('company-a')
    await queueMarkupDelete('doc-9', 'm1')
    expect((await db.outbox.toArray())[0].docId).toBe('doc-9')
    setActiveCompanyId('company-b') // switched before the queue drained
    await drain()
    const sent = calls.find(c => c.url.includes('/markups/m1'))!
    expect(sent.url).toBe('/api/documents/doc-9/markups/m1')
    expect(await db.outbox.count()).toBe(0)
  })
})
