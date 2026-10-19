import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../api'
import type { Markup } from '../markups/types'
import { classifyError } from './classify'
import { db } from './db'
import type { OutboxItem } from './db'
import {
  applyRemoteMarkup, backoffMs, configure, drain, mergeServerMarkups, queueMarkupDelete, queueMarkupPut,
  queuePhotoCreate, queuePhotoDelete, resetSyncState, retryItem, subscribe,
} from './sync'
import type { SyncEvent } from './sync'

const mk = (id: string, over: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd1', page: 1, type: 'device',
  geometry: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  style: { stroke: '#000', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 },
  text: '', layer_id: null, ...over,
})

let sent: OutboxItem[]
let behavior: (item: OutboxItem) => unknown

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  resetSyncState()
  sent = []
  behavior = () => ({})
  configure({ autoRetry: false, executor: async item => { sent.push(item); return behavior(item) } })
})

describe('classifyError', () => {
  it('classifies', () => {
    expect(classifyError(new TypeError('Failed to fetch'))).toBe('network')
    expect(classifyError(new ApiError(401, 'x'))).toBe('auth')
    expect(classifyError(new ApiError(503, 'x'))).toBe('network')
    expect(classifyError(new ApiError(500, 'x'))).toBe('retry')
    expect(classifyError(new ApiError(429, 'x'))).toBe('retry')
    expect(classifyError(new ApiError(403, 'x'))).toBe('permanent')
    expect(classifyError(new ApiError(404, 'x'))).toBe('permanent')
    expect(classifyError(new ApiError(422, 'x'))).toBe('permanent')
  })
  it('backs off exponentially up to 30s', () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 30000])
  })
})

describe('outbox ordering and coalescing', () => {
  it('writes Dexie and the outbox, and replays in call order', async () => {
    await queueMarkupPut('d1', mk('a'))
    await queueMarkupPut('d1', mk('b'))
    await queueMarkupDelete('d1', 'a')
    expect((await db.markups.toArray()).map(m => m.id)).toEqual(['b'])
    await drain()
    expect(sent.map(i => `${i.kind}:${i.targetId}`)).toEqual(['markup_put:b', 'markup_delete:a'])
    expect(await db.outbox.count()).toBe(0)
  })

  it('keeps only the latest payload of consecutive puts to the same markup', async () => {
    await queueMarkupPut('d1', mk('a', { text: '1' }))
    await queueMarkupPut('d1', mk('b'))
    await queueMarkupPut('d1', mk('a', { text: '2' }))
    await queueMarkupPut('d1', mk('a', { text: '3' }))
    const items = await db.outbox.toArray()
    expect(items).toHaveLength(2)
    expect(items.find(i => i.targetId === 'a')!.payload.text).toBe('3')
    await drain()
    expect(sent.filter(i => i.targetId === 'a')).toHaveLength(1)
  })

  it('does not coalesce into an item that is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    configure({ executor: async item => { sent.push(item); if (sent.length === 1) await gate; return {} } })
    await queueMarkupPut('d1', mk('a', { text: '1' }))
    const running = drain()
    await new Promise(r => setTimeout(r, 30))
    await queueMarkupPut('d1', mk('a', { text: '2' }))
    release()
    await running
    await drain()
    expect(sent.map(i => i.payload.text)).toEqual(['1', '2'])
  })

  it('a delete cancels a queued put but is still sent', async () => {
    await queueMarkupPut('d1', mk('a'))
    await queueMarkupDelete('d1', 'a')
    expect((await db.outbox.toArray()).map(i => i.kind)).toEqual(['markup_delete'])
  })

  it('put after delete (undo) is queued after the delete', async () => {
    await queueMarkupDelete('d1', 'a')
    await queueMarkupPut('d1', mk('a'))
    expect((await db.outbox.toArray()).map(i => i.kind)).toEqual(['markup_delete', 'markup_put'])
  })

  it('deleting a never-uploaded photo cancels it with no network traffic', async () => {
    await queuePhotoCreate({ id: 'p1', markupId: 'a', blob: new Blob(['x']), width: 1, height: 1 })
    expect(await db.outbox.count()).toBe(1)
    await queuePhotoDelete('p1')
    expect(await db.outbox.count()).toBe(0)
    expect(await db.attachments.count()).toBe(0)
    expect(await db.photoBlobs.count()).toBe(0)
  })
})

describe('retry classification', () => {
  it('network error keeps the item and stops the queue', async () => {
    await queueMarkupPut('d1', mk('a'))
    await queueMarkupPut('d1', mk('b'))
    behavior = () => { throw new TypeError('Failed to fetch') }
    await drain()
    expect(sent).toHaveLength(1) // stopped after the first failure
    const items = await db.outbox.orderBy('seq').toArray()
    expect(items.map(i => i.status)).toEqual(['pending', 'pending'])
    expect(items[0].attempts).toBe(1)
    behavior = () => ({})
    await drain()
    expect(await db.outbox.count()).toBe(0)
    expect(sent.map(i => i.targetId)).toEqual(['a', 'a', 'b'])
  })

  it('a 4xx marks the item failed and continues with the rest', async () => {
    await queueMarkupPut('d1', mk('a'))
    await queueMarkupPut('d1', mk('b'))
    behavior = i => { if (i.targetId === 'a') throw new ApiError(403, 'Not allowed'); return {} }
    await drain()
    const left = await db.outbox.toArray()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ targetId: 'a', status: 'failed', lastError: 'Not allowed' })
    behavior = () => ({})
    await retryItem(left[0].seq!)
    await drain()
    expect(await db.outbox.count()).toBe(0)
  })

  it('a 5xx is retried, not failed', async () => {
    await queueMarkupPut('d1', mk('a'))
    behavior = () => { throw new ApiError(500, 'boom') }
    await drain()
    expect((await db.outbox.toArray())[0]).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('a 401 stops draining and asks for sign-in', async () => {
    const events: SyncEvent[] = []
    const off = subscribe(e => events.push(e))
    await queueMarkupPut('d1', mk('a'))
    await queueMarkupPut('d1', mk('b'))
    behavior = () => { throw new ApiError(401, 'Unauthorized') }
    await drain()
    off()
    expect(sent).toHaveLength(1)
    expect(events.some(e => e.type === 'auth-required')).toBe(true)
    expect((await db.outbox.toArray()).every(i => i.status === 'pending')).toBe(true)
    await drain() // stays stopped until resumeSync()
    expect(sent).toHaveLength(1)
  })

  it('a 404 on a delete counts as done', async () => {
    await queueMarkupDelete('d1', 'gone')
    behavior = () => { throw new ApiError(404, 'Not found') }
    await drain()
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('adopting server rows', () => {
  it('copies the server tag/version/names into Dexie and emits an event', async () => {
    const events: SyncEvent[] = []
    const off = subscribe(e => events.push(e))
    await queueMarkupPut('d1', mk('a'))
    behavior = () => ({ ...mk('a'), tag: 'CAM-07', version: 3, created_by_name: 'Pat', updated_by_name: 'Pat', updated_at: 't' })
    await drain()
    off()
    expect(await db.markups.get('a')).toMatchObject({ tag: 'CAM-07', version: 3, created_by_name: 'Pat' })
    expect(events.find(e => e.type === 'markup-adopted')).toMatchObject({ id: 'a', docId: 'd1' })
  })

  it('does not overwrite content or a tag the user changed meanwhile', async () => {
    await queueMarkupPut('d1', mk('a', { text: 'old' }))
    configure({
      executor: async item => {
        sent.push(item)
        if (sent.length > 1) return {}
        // user edits while the request is in flight (queued behind the in-flight one)
        await queueMarkupPut('d1', mk('a', { text: 'new', tag: 'MINE' }))
        return { ...mk('a', { text: 'old' }), tag: 'CAM-01', version: 1 }
      },
    })
    await drain()
    expect(await db.markups.get('a')).toMatchObject({ text: 'new', tag: 'MINE' })
    expect(sent).toHaveLength(2) // the in-flight edit did not swallow the newer one
  })

  it('adopts the photo row after upload', async () => {
    await queuePhotoCreate({ id: 'p1', markupId: 'a', blob: new Blob(['x']), width: 4, height: 3 })
    expect((await db.attachments.get('p1'))!.pending).toBe(true)
    behavior = () => ({ id: 'p1', markup_id: 'a', caption: '', width: 4, height: 3, created_at: 's', created_by: 'u', has_annotation: false })
    await drain()
    expect(await db.attachments.get('p1')).toMatchObject({ created_by: 'u', pending: false })
  })
})

describe('server refresh keeps unsent local work', () => {
  it('mergeServerMarkups prefers local rows that have queued writes', async () => {
    await queueMarkupPut('d1', mk('a', { text: 'local' }))
    const merged = await mergeServerMarkups('d1', [mk('a', { text: 'server' }), mk('b')])
    expect(merged.find(m => m.id === 'a')!.text).toBe('local')
    expect(merged.map(m => m.id).sort()).toEqual(['a', 'b'])
    await db.outbox.clear()
    const again = await mergeServerMarkups('d1', [mk('a')])
    expect(again.map(m => m.id)).toEqual(['a'])
  })

  it('applyRemoteMarkup is ignored while the markup has unsent edits', async () => {
    await queueMarkupPut('d1', mk('a', { text: 'local' }))
    expect(await applyRemoteMarkup(mk('a', { text: 'remote' }))).toBe(false)
    expect(await applyRemoteMarkup(mk('z', { text: 'remote' }))).toBe(true)
    expect((await db.markups.get('a'))!.text).toBe('local')
  })
})
