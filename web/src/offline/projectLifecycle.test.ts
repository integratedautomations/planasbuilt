import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimCache, releaseCache } from './cacheOwner'
import { forgetProjectLocal, loadProjects } from './cache'
import { db } from './db'
import { resetSyncState, setSyncUser } from './sync'

const mkProject = (id: string, archived = false) => ({ id, name: id, created_at: '', role: 'admin' as const, archived })

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  resetSyncState(); releaseCache()
  setSyncUser({ id: 'dana', name: 'Dana' })
  await claimCache('dana')
})
afterEach(() => { vi.unstubAllGlobals() })

describe('offline cache and archived or deleted projects', () => {
  it('never keeps archived projects in the cached list', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([mkProject('a'), mkProject('b', true)]), { status: 200 }))
    expect((await loadProjects(true)).data.map(p => p.id)).toEqual(['a', 'b'])
    expect((await db.projects.toArray()).map(p => p.id)).toEqual(['a'])
  })

  it('forgets a deleted project with its plans, markups and offline copy', async () => {
    await db.projects.bulkPut([mkProject('p1'), mkProject('p2')])
    await db.documents.bulkPut([{ id: 'd1', project_id: 'p1', name: 'A', created_at: '' }, { id: 'd2', project_id: 'p2', name: 'B', created_at: '' }] as any)
    await db.pdfs.bulkPut([{ id: 'd1', data: new ArrayBuffer(1), size: 1, cachedAt: 0 }, { id: 'd2', data: new ArrayBuffer(1), size: 1, cachedAt: 0 }])
    await db.markups.bulkPut([{ id: 'm1', document_id: 'd1' }, { id: 'm2', document_id: 'd2' }] as any)
    await db.layers.bulkPut([{ id: 'l1', project_id: 'p1' }, { id: 'l2', project_id: 'p2' }] as any)
    await forgetProjectLocal('p1')
    expect((await db.projects.toArray()).map(p => p.id)).toEqual(['p2'])
    expect((await db.documents.toArray()).map(d => d.id)).toEqual(['d2'])
    expect((await db.pdfs.toArray()).map(d => d.id)).toEqual(['d2'])
    expect((await db.markups.toArray()).map(m => m.id)).toEqual(['m2'])
    expect((await db.layers.toArray()).map(l => l.id)).toEqual(['l2'])
  })
})
