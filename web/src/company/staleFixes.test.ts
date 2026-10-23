import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetActiveCompanyForTests, setActiveCompanyId } from './activeCompany'
import { pendingInvitations, showSwitcher, switchable } from './switcher'
import type { CompanyRow } from './switcher'
import { db, OfflineDb } from '../offline/db'
import { isStale, loadProjects, loadSymbolSets } from '../offline/cache'
import { classifyError } from '../offline/classify'
import { ApiError } from '../api'
import { probeFolderZip } from '../pages/DownloadProjectFolder'

let store: Record<string, string>
beforeEach(async () => {
  store = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } })
  resetActiveCompanyForTests()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => { vi.unstubAllGlobals(); resetActiveCompanyForTests() })

describe('late answers keep their own company', () => {
  it('a response for A that arrives after switching to B is stored as A, B cache untouched, and rejected as stale', async () => {
    setActiveCompanyId('A')
    await db.projects.put({ id: 'pb', name: 'B proj', company_id: 'B' } as any)
    let release!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { release = r })))
    const p = loadProjects()
    const settled = p.catch(e => e)
    setActiveCompanyId('B')
    release(new Response(JSON.stringify([{ id: 'pa', name: 'A proj', company_id: 'A' }]), { status: 200 }))
    const err = await settled; expect(isStale(err)).toBe(true)
    expect((await db.projects.toArray()).map(r => [r.id, r.company_id]).sort()).toEqual([['pa', 'A'], ['pb', 'B']])
  })
  it('symbol sets fetched for A are stamped A even when B is active by the time they arrive', async () => {
    setActiveCompanyId('A')
    let release!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { release = r })))
    const settled = loadSymbolSets().catch(e => e)
    setActiveCompanyId('B')
    release(new Response(JSON.stringify([{ id: 's1', name: 'S' }]), { status: 200 }))
    const err = await settled; expect(isStale(err)).toBe(true)
    expect((await db.symbolSets.get('s1'))?.company_id).toBe('A')
  })
})

describe('upgrade stamps pre-scoping rows', () => {
  it('rows without company_id get the last known company', async () => {
    store['planmark.activeCompany'] = 'C1'
    const name = 'upgrade-test-db'
    const old = new Dexie(name)
    old.version(4).stores({ projects: 'id, company_id', symbolSets: 'id, company_id', deviceTypes: 'id, symbol_set_id, company_id', products: 'id, device_type_id, company_id', cableTypes: 'id, company_id' })
    await old.table('projects').bulkPut([{ id: 'p1' }, { id: 'p2', company_id: 'C2' }])
    old.close()
    const upgraded = new OfflineDb(name)
    await upgraded.open()
    expect((await upgraded.projects.get('p1'))?.company_id).toBe('C1')
    expect((await upgraded.projects.get('p2'))?.company_id).toBe('C2')
    upgraded.close(); await Dexie.delete(name)
  })
})

describe('423 company archived', () => {
  it('is a permanent failure', () => { expect(classifyError(new ApiError(423, 'company archived'))).toBe('permanent') })
})

describe('invitations', () => {
  const row = (id: string, over: Partial<CompanyRow> = {}): CompanyRow => ({ id, name: id, archived: false, role: 'member' as any, member: true, ...over })
  it('lists pending ones and keeps them out of the switcher', () => {
    const rows = [row('a'), row('b'), row('c', { pending: true, member: false })]
    expect(pendingInvitations(rows).map(c => c.id)).toEqual(['c'])
    expect(switchable({}, rows).map(c => c.id)).toEqual(['a', 'b'])
    expect(showSwitcher({}, [row('a'), row('c', { pending: true })])).toBe(false)
    expect(pendingInvitations([row('a')])).toEqual([])
  })
})

describe('download probe', () => {
  it('returns the server error message and null on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Project is too large to zip' }), { status: 413 })))
    expect(await probeFolderZip('/api/x')).toBe('Project is too large to zip')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('zip', { status: 200 })))
    expect(await probeFolderZip('/api/x')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    expect(await probeFolderZip('/api/x')).toMatch(/Too many/)
  })
})
