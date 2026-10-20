import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Markup } from '../markups/types'
import { cacheAllowed, claimCache, releaseCache } from './cacheOwner'
import { loadProjects } from './cache'
import { db } from './db'
import { configure, queueMarkupPut, resetSyncState, setSyncUser } from './sync'

const mk = (id: string): Markup => ({
  id, document_id: 'd1', page: 1, type: 'device', geometry: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  style: { stroke: '#000', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }, text: '', layer_id: null,
})

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  resetSyncState(); releaseCache()
  configure({ autoRetry: false, executor: async () => ({}) })
})

describe('cache ownership', () => {
  it('purges the previous user cache but keeps the outbox when another user signs in', async () => {
    setSyncUser({ id: 'dana', name: 'Dana' })
    await claimCache('dana')
    await db.projects.put({ id: 'p1', name: 'Secret', created_at: '', role: 'admin' })
    await db.pdfs.put({ id: 'd1', data: new ArrayBuffer(1), size: 1, cachedAt: 0 })
    await queueMarkupPut('d1', mk('m1'))
    setSyncUser({ id: 'sam', name: 'Sam' })
    await claimCache('sam')
    expect(await db.projects.count()).toBe(0)
    expect(await db.pdfs.count()).toBe(0)
    expect(await db.outbox.count()).toBe(1)
  })
  it('leaves the cache alone for the same user', async () => {
    await claimCache('dana')
    await db.projects.put({ id: 'p1', name: 'Mine', created_at: '', role: 'admin' })
    await claimCache('dana')
    expect(await db.projects.count()).toBe(1)
  })
  it('refuses cached reads when nobody has claimed the cache', async () => {
    await db.projects.put({ id: 'p1', name: 'Secret', created_at: '', role: 'admin' })
    expect(await cacheAllowed()).toBe(false)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as any
    try { await expect(loadProjects()).rejects.toThrow() } finally { globalThis.fetch = realFetch }
  })
})
