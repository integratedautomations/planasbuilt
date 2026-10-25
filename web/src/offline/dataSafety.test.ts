import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { buildBackup, parseBackup, restoreBackup } from './backup'
import { configure, queuePhotoCreate, queueMarkupPut, resetSyncState, setSyncUser, flushWrites } from './sync'
import { DISMISS_MS, dismiss, installBannerKind, isDismissed, isIos } from './installPrompt'
import { isStale, STALE_MS, agoText } from './unsent'
import { leaveGuardActive, setLeaveGuard } from './leaveGuard'
import { persistWarning, readStorageState, requestPersistence, resetPersistenceRequest } from './storagePersist'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'

describe('storage persistence', () => {
  beforeEach(() => resetPersistenceRequest())
  it('requests persist and reports state', async () => {
    const persist = vi.fn(async () => false)
    vi.stubGlobal('navigator', { storage: { persist, persisted: async () => false, estimate: async () => ({ usage: 10, quota: 100 }) } })
    expect(await requestPersistence()).toBe(false)
    await requestPersistence()
    expect(persist).toHaveBeenCalledTimes(1)
    const st = await readStorageState()
    expect(st).toEqual({ persisted: false, usage: 10, quota: 100 })
    expect(persistWarning(st)).toMatch(/clear offline data/)
    expect(persistWarning({ ...st, persisted: true })).toBeNull()
  })
  it('handles unsupported', async () => {
    vi.stubGlobal('navigator', {})
    expect(await requestPersistence()).toBeNull()
    expect(await readStorageState()).toEqual({ persisted: null, usage: null, quota: null })
  })
})

describe('install banner', () => {
  const tab = { userAgent: IPHONE, standalone: false }
  const base = { relevant: true, dismissed: false, hasPrompt: false }
  it('iOS tab shows, standalone does not', () => {
    expect(installBannerKind({ ...base, env: tab })).toBe('ios')
    expect(installBannerKind({ ...base, env: { ...tab, standalone: true } })).toBeNull()
  })
  it('needs relevance and no dismissal', () => {
    expect(installBannerKind({ ...base, env: tab, relevant: false })).toBeNull()
    expect(installBannerKind({ ...base, env: tab, dismissed: true })).toBeNull()
  })
  it('chromium uses the captured prompt; iPadOS detected', () => {
    const d = { userAgent: 'Chrome', standalone: false }
    expect(installBannerKind({ ...base, env: d })).toBeNull()
    expect(installBannerKind({ ...base, env: d, hasPrompt: true })).toBe('chromium')
    expect(isIos({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isIos({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
  })
  it('dismissal lasts 7 days', () => {
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    expect(isDismissed(1000, store)).toBe(false)
    dismiss(1000, store)
    expect(isDismissed(1000 + DISMISS_MS - 1, store)).toBe(true)
    expect(isDismissed(1000 + DISMISS_MS + 1, store)).toBe(false)
  })
})

describe('unsent age', () => {
  it('threshold is 24h', () => {
    expect(isStale(null, 1e9)).toBe(false)
    expect(isStale(0, STALE_MS)).toBe(false)
    expect(isStale(0, STALE_MS + 1)).toBe(true)
    expect(agoText(0, 4 * 60_000)).toBe('4 min ago')
  })
})

describe('leave guard', () => {
  it('registers only while active', () => {
    const t = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    setLeaveGuard(false, t)
    expect(t.addEventListener).not.toHaveBeenCalled()
    setLeaveGuard(true, t); setLeaveGuard(true, t)
    expect(t.addEventListener).toHaveBeenCalledTimes(1)
    expect(leaveGuardActive()).toBe(true)
    setLeaveGuard(false, t)
    expect(t.removeEventListener).toHaveBeenCalledTimes(1)
    expect(leaveGuardActive()).toBe(false)
  })
})

describe('backup round trip', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map(t => t.clear()))
    resetSyncState()
    setSyncUser({ id: 'u1', name: 'U' })
    configure({ autoRetry: false, executor: async () => { throw new TypeError('Failed to fetch') } })
  })
  it('exports and restores photos', async () => {
    await queuePhotoCreate({ id: 'a1', markupId: 'm1', blob: new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'image/jpeg' }), width: 1, height: 1 })
    await flushWrites()
    const file = await buildBackup()
    expect(JSON.stringify(file)).not.toMatch(/token/i)
    expect(file.items).toHaveLength(1)
    expect(file.photos.map(p => p.variant)).toEqual(['original'])
    const text = JSON.stringify(file)
    await Promise.all(db.tables.map(t => t.clear()))
    const parsed = parseBackup(text)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(await restoreBackup(parsed.file)).toEqual({ restored: 1, skipped: 0, photos: 1 })
    const row = await db.photoBlobs.get('a1:original')
    expect([...new Uint8Array(await row!.blob.arrayBuffer())]).toEqual([1, 2, 3, 250])
    expect(await db.photoBlobs.get('a1:view')).toBeTruthy()
    expect((await db.outbox.toArray())[0].status).toBe('pending')
    // restoring again is a no-op
    expect((await restoreBackup(parsed.file)).restored).toBe(0)
    void queueMarkupPut
  })
  it('rejects bad files', () => {
    expect(parseBackup('nope').ok).toBe(false)
    expect(parseBackup('{"format":"x"}').ok).toBe(false)
    expect(parseBackup('{"format":"planasbuilt-unsent","version":99,"items":[],"photos":[],"attachments":[]}').ok).toBe(false)
    expect(parseBackup('{"format":"planasbuilt-unsent","version":1,"items":[{"kind":"evil"}],"photos":[],"attachments":[]}').ok).toBe(false)
    expect(parseBackup('{"format":"planasbuilt-unsent","version":1,"items":[],"photos":[],"attachments":[]}').ok).toBe(true)
  })
})
