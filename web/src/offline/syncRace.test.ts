import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../api'
import type { Markup } from '../markups/types'
import { db } from './db'
import type { OutboxItem } from './db'
import {
  ackedSince, ackSnapshot, applyRemoteMarkup, carryPutMeta, configure, discardItem, drain, hasPending, mergeServerMarkups, pendingMarkupIds,
  planMerge, queueMarkupDelete, queueMarkupPut, queuePhotoCreate, resetSyncState, retryItem, setSyncUser,
} from './sync'

const mk = (id: string, over: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd1', page: 1, type: 'device',
  geometry: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  style: { stroke: '#000', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 },
  text: '', layer_id: null, version: 1, ...over,
})
const blob = () => new Blob(['x'], { type: 'image/jpeg' })

let sent: OutboxItem[]
let behavior: (item: OutboxItem) => unknown
beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  resetSyncState()
  setSyncUser({ id: 'u1', name: 'U' })
  sent = []
  behavior = item => (item.kind === 'markup_put' ? { ...item.payload, id: item.targetId, version: 2 } : {})
  configure({ autoRetry: false, executor: async item => { sent.push(item); return behavior(item) } })
})

describe('planMerge (pure rules)', () => {
  const none = () => false
  const L = (...ms: Markup[]) => new Map(ms.map(m => [m.id, m]))
  it('takes newer server rows and removes rows the server no longer lists', () => {
    const plan = planMerge(L(mk('a', { version: 1 }), mk('gone')), [mk('a', { version: 2 }), mk('new')], new Set(), new Set(), none)
    expect(plan.put.map(r => r.id)).toEqual(['a', 'new'])
    expect(plan.remove).toEqual(['gone'])
  })
  it('keeps the local row when it is newer than the server row', () => {
    const plan = planMerge(L(mk('a', { version: 5 })), [mk('a', { version: 4 })], new Set(), new Set(), none)
    expect(plan.put).toEqual([])
  })
  it('keeps rows with pending edits and rows acknowledged since the request', () => {
    const plan = planMerge(L(mk('p'), mk('k'), mk('x', { version: 1 })), [mk('p', { version: 9 }), mk('x', { version: 9 })], new Set(['p']), new Set(), id => id === 'x' || id === 'k')
    expect(plan.put).toEqual([]) // p pending, x acknowledged
    expect(plan.remove).toEqual([]) // k acknowledged (not listed), p pending
  })
  it('does not remove a row whose save failed (it never reached the server)', () => {
    expect(planMerge(L(mk('f')), [], new Set(), new Set(['f']), none).remove).toEqual([])
  })
  it('carryPutMeta keeps the oldest base version and an explicit restore', () => {
    expect(carryPutMeta({ base_version: 3 }, { base_version: 5, text: 'x' })).toEqual({ base_version: 3, text: 'x' })
    expect(carryPutMeta({}, { base_version: 5 })).toEqual({ base_version: 5 })
    expect(carryPutMeta({ restore: true }, { text: 'x' })).toEqual({ text: 'x', restore: true })
  })
})

describe('reconnect catch-up vs the outbox drain', () => {
  it('a put that finishes while the list request is in flight is not reverted by the older list', async () => {
    await db.markups.put(mk('a', { text: 'old', version: 1 }))
    const snapshot = ackSnapshot() // taken before GET /markups goes out
    const staleList = [mk('a', { text: 'old', version: 1 })] // what the server computed before the PUT landed
    await queueMarkupPut('d1', mk('a', { text: 'edited', version: 1 }))
    await drain() // the PUT finishes (outbox empty, version 2) before the list comes back
    expect(await db.outbox.count()).toBe(0)
    expect(ackedSince('a', snapshot)).toBe(true)

    const merged = await mergeServerMarkups('d1', staleList, snapshot)
    expect(merged.find(m => m.id === 'a')).toMatchObject({ text: 'edited', version: 2 })
  })

  it('without the snapshot an older list would win unless the local row is newer: the version rule also protects it', async () => {
    await db.markups.put(mk('a', { text: 'old', version: 1 }))
    await queueMarkupPut('d1', mk('a', { text: 'edited', version: 1 }))
    await drain()
    const merged = await mergeServerMarkups('d1', [mk('a', { text: 'old', version: 1 })]) // no snapshot at all
    expect(merged.find(m => m.id === 'a')?.text).toBe('edited') // local version 2 > server version 1
  })

  it('a delete acknowledged during the request is not brought back by the list', async () => {
    await db.markups.put(mk('a'))
    const snapshot = ackSnapshot()
    const staleList = [mk('a')]
    await queueMarkupDelete('d1', 'a')
    await drain()
    expect((await mergeServerMarkups('d1', staleList, snapshot)).map(m => m.id)).toEqual([])
  })

  it('an acknowledgement from before the snapshot does not protect anything', async () => {
    await db.markups.put(mk('a', { version: 1 }))
    await queueMarkupPut('d1', mk('a', { text: 'v2', version: 1 }))
    await drain()
    const snapshot = ackSnapshot()
    const merged = await mergeServerMarkups('d1', [mk('a', { text: 'newer from someone', version: 7 })], snapshot)
    expect(merged[0]).toMatchObject({ text: 'newer from someone', version: 7 })
  })
})

describe('failed items do not freeze a markup', () => {
  it('remote changes go through and the failed item stays for retry/discard', async () => {
    await db.markups.put(mk('a', { text: 'mine' }))
    await queueMarkupPut('d1', mk('a', { text: 'mine' }))
    behavior = () => { throw new ApiError(400, 'bad') }
    await drain()
    const [failed] = await db.outbox.toArray()
    expect(failed.status).toBe('failed')
    expect(await hasPending('a')).toBe(false)
    expect((await pendingMarkupIds('d1')).size).toBe(0)

    expect(await applyRemoteMarkup(mk('a', { text: 'theirs', version: 5 }))).toBe(true)
    expect((await db.markups.get('a'))?.text).toBe('theirs')
    expect(await db.outbox.count()).toBe(1) // still listed for retry / discard
    await discardItem(failed.seq!)
    expect(await db.outbox.count()).toBe(0)
  })

  it('a markup whose first save failed stays visible locally when the server list lacks it', async () => {
    await queueMarkupPut('d1', mk('new', { version: undefined }))
    behavior = () => { throw new ApiError(400, 'bad') }
    await drain()
    expect((await mergeServerMarkups('d1', [])).map(m => m.id)).toEqual(['new'])
  })
})

describe('offline photos survive a failed markup save', () => {
  it('keeps the photo (marked failed) when its markup never got to the server, and retries it with the markup', async () => {
    await queueMarkupPut('d1', mk('a', { version: undefined }))
    await queuePhotoCreate({ id: 'p1', markupId: 'a', blob: blob(), width: 1, height: 1 })
    let putFails = true
    behavior = item => {
      if (item.kind === 'markup_put') { if (putFails) throw new ApiError(400, 'Unknown layer'); return { ...item.payload, id: 'a', version: 1 } }
      if (item.kind === 'photo_post') { if (putFails) throw new ApiError(404, 'Not found'); return { id: 'p1', markup_id: 'a', caption: '', width: 1, height: 1, created_at: '', created_by: '', has_annotation: false } }
      return {}
    }
    await drain()
    const items = await db.outbox.toArray()
    expect(items.map(i => [i.kind, i.status])).toEqual([['markup_put', 'failed'], ['photo_post', 'failed']])
    expect(await db.photoBlobs.get('p1:original')).toBeTruthy()
    expect(await db.attachments.get('p1')).toBeTruthy()

    putFails = false
    await retryItem(items[0].seq!)
    await drain()
    expect(await db.outbox.count()).toBe(0)
    expect((await db.attachments.get('p1'))?.pending).toBe(false)
  })

  it('still drops the photo quietly when the markup is really gone (no save of it left)', async () => {
    await db.markups.put(mk('a'))
    await queuePhotoCreate({ id: 'p1', markupId: 'a', blob: blob(), width: 1, height: 1 })
    behavior = () => { throw new ApiError(404, 'Not found') }
    await drain()
    expect(await db.outbox.count()).toBe(0)
    expect(await db.photoBlobs.get('p1:original')).toBeUndefined()
  })
})

describe('base_version / restore / conflicts', () => {
  it('sends the version an edit was based on, and carries it through coalescing', async () => {
    await db.markups.put(mk('a', { version: 3 }))
    await queueMarkupPut('d1', mk('a', { text: 'one', version: 3 }))
    await queueMarkupPut('d1', mk('a', { text: 'two', version: 3 }))
    const [item] = await db.outbox.toArray()
    expect(item.payload).toMatchObject({ text: 'two', base_version: 3 })
    expect(item.payload.restore).toBeUndefined()
  })

  it('a brand new markup has no base version', async () => {
    await queueMarkupPut('d1', mk('n', { version: undefined }))
    expect((await db.outbox.toArray())[0].payload.base_version).toBeUndefined()
  })

  it('undo of a delete sends an explicit restore', async () => {
    const m = mk('a', { version: 4 })
    await db.markups.put(m)
    await queueMarkupDelete('d1', 'a')
    await queueMarkupPut('d1', m, { restore: true })
    const items = await db.outbox.toArray()
    expect(items.map(i => i.kind)).toEqual(['markup_delete', 'markup_put'])
    expect(items[1].payload).toMatchObject({ restore: true, base_version: 4 })
  })

  it('edits queued behind a successful put are based on the version it produced', async () => {
    await db.markups.put(mk('a', { version: 1 }))
    const bodies: any[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    configure({ executor: async item => { bodies.push(item.payload); if (bodies.length === 1) await gate; return { ...item.payload, id: 'a', version: 10 } } })
    await queueMarkupPut('d1', mk('a', { text: 'v1', version: 1 }))
    const d = drain()
    await new Promise(r => setTimeout(r, 20))
    await queueMarkupPut('d1', mk('a', { text: 'v2', version: 1 })) // made while the first was in flight
    release()
    await d; await drain()
    expect(bodies.map(b => [b.text, b.base_version])).toEqual([['v1', 1], ['v2', 10]])
  })

  it('a 409 "deleted on the server" drops the local row and the queued edit', async () => {
    await db.markups.put(mk('a', { version: 1 }))
    await queueMarkupPut('d1', mk('a', { text: 'offline edit', version: 1 }))
    behavior = () => { throw new ApiError(409, 'deleted', { conflict: true, current: { ...mk('a', { version: 3 }), deleted: true } }) }
    await drain()
    expect(await db.outbox.count()).toBe(0)
    expect(await db.markups.get('a')).toBeUndefined()
  })

  it('a 409 "moved by a page operation" adopts the server page/geometry, keeps the user fields and sends them again', async () => {
    await db.markups.put(mk('a', { version: 1, page: 3 }))
    await queueMarkupPut('d1', mk('a', { text: 'offline edit', page: 3, version: 1 }))
    const moved = { ...mk('a', { version: 4, page: 1 }), geometry: { x: 7, y: 8, width: 10, height: 10, rotation: 90 }, deleted: false }
    let first = true
    behavior = item => {
      if (first) { first = false; throw new ApiError(409, 'moved', { conflict: true, current: moved }) }
      return { ...item.payload, id: 'a', version: 5 }
    }
    await drain()
    expect(sent).toHaveLength(2)
    expect(sent[1].payload).toMatchObject({ text: 'offline edit', page: 1, base_version: 4, geometry: { x: 7, y: 8, rotation: 90 } })
    expect(await db.outbox.count()).toBe(0)
    expect(await db.markups.get('a')).toMatchObject({ text: 'offline edit', page: 1, version: 5, geometry: { x: 7, rotation: 90 } })
  })

  it('gives up (failed, visible) when the same markup keeps conflicting', async () => {
    await db.markups.put(mk('a', { version: 1 }))
    await queueMarkupPut('d1', mk('a', { version: 1 }))
    let v = 1
    behavior = () => { throw new ApiError(409, 'moved', { conflict: true, current: { ...mk('a', { version: ++v }), deleted: false } }) }
    await drain()
    const [item] = await db.outbox.toArray()
    expect(item.status).toBe('failed')
  })

  it('a 409 without a conflict body (another document) is just a failed item', async () => {
    await queueMarkupPut('d1', mk('a'))
    behavior = () => { throw new ApiError(409, 'Markup belongs to another document', { error: 'x' }) }
    await drain()
    expect((await db.outbox.toArray())[0].status).toBe('failed')
  })
})
