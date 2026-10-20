import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../api'
import type { Markup } from '../markups/types'
import { db } from './db'
import type { OutboxItem } from './db'
import {
  applyRemoteMarkup, applyRemoteMarkupDelete, configure, drain, queueMarkupDelete, queueMarkupPut, queuePhotoCreate,
  resetSyncState, setSyncUser, subscribe,
} from './sync'

const mk = (id: string, over: Partial<Markup> = {}): Markup => ({
  id, document_id: 'd1', page: 1, type: 'device', geometry: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  style: { stroke: '#000', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }, text: '', layer_id: null, ...over,
})
let sent: OutboxItem[]
beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  resetSyncState()
  sent = []
  configure({ autoRetry: false, executor: async item => { sent.push(item); return {} }, fetchMarkups: async () => [] })
})

describe('no user known', () => {
  it('sends nothing until a user is set, then sends their (and legacy) items', async () => {
    await queueMarkupPut('d1', mk('a')) // queued with nobody signed in -> no owner stamp
    await drain()
    expect(sent).toHaveLength(0)
    setSyncUser({ id: 'u1', name: 'U' })
    await drain()
    expect(sent.map(i => i.targetId)).toEqual(['a'])
  })
})

describe('coalescing vs the worker', () => {
  it('never loses an update made while the first put is in flight', async () => {
    setSyncUser({ id: 'u1', name: 'U' })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const bodies: string[] = []
    configure({ executor: async item => { bodies.push(item.payload.text); if (bodies.length === 1) await gate; return {} } })
    await queueMarkupPut('d1', mk('a', { text: 'v1' }))
    const d = drain()
    await new Promise(r => setTimeout(r, 20)) // v1 is in flight
    await queueMarkupPut('d1', mk('a', { text: 'v2' }))
    release()
    await d
    await drain()
    expect(bodies).toEqual(['v1', 'v2'])
    expect(await db.outbox.count()).toBe(0)
  })

  it('an update racing the start of the drain is either folded in before the read or sent after', async () => {
    setSyncUser({ id: 'u1', name: 'U' })
    const bodies: string[] = []
    configure({ executor: async item => { bodies.push(item.payload.text); return {} } })
    await queueMarkupPut('d1', mk('a', { text: 'v1' }))
    const d = drain()
    const w = queueMarkupPut('d1', mk('a', { text: 'v2' }))
    await Promise.all([d, w])
    await drain()
    expect(bodies[bodies.length - 1]).toBe('v2')
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('remote changes skipped while local edits are pending', () => {
  it('refetches after the local item is done and adopts a newer server row', async () => {
    setSyncUser({ id: 'u1', name: 'U' })
    await db.markups.put(mk('a', { version: 1 }))
    await queueMarkupPut('d1', mk('a', { text: 'mine', version: 1 }))
    expect(await applyRemoteMarkup(mk('a', { text: 'theirs', version: 5 }))).toBe(false)
    configure({ fetchMarkups: async () => [mk('a', { text: 'theirs', version: 5 })] })
    const events: string[] = []
    const off = subscribe(e => { if (e.type === 'remote-markups') events.push('remote') })
    await drain()
    off()
    expect((await db.markups.get('a'))!.text).toBe('theirs')
    expect(events).toEqual(['remote'])
  })
  it('removes the markup when the server says it was deleted', async () => {
    setSyncUser({ id: 'u1', name: 'U' })
    await queueMarkupPut('d1', mk('a'))
    expect(await applyRemoteMarkupDelete('d1', 'a')).toBe(false)
    configure({ fetchMarkups: async () => [] })
    await drain()
    expect(await db.markups.get('a')).toBeUndefined()
  })
  it('keeps the local row when the server version is not newer', async () => {
    setSyncUser({ id: 'u1', name: 'U' })
    await queueMarkupPut('d1', mk('a', { text: 'mine', version: 3 }))
    await applyRemoteMarkup(mk('a', { text: 'old', version: 2 }))
    configure({ executor: async () => ({ version: 4 }), fetchMarkups: async () => [mk('a', { text: 'old', version: 2 })] })
    await drain()
    expect((await db.markups.get('a'))!.text).toBe('mine')
  })
})

describe('photos of deleted markups', () => {
  it('deleting a markup cancels photos that were never uploaded', async () => {
    setSyncUser({ id: 'u1', name: 'U' })
    await queueMarkupPut('d1', mk('m1'))
    await queuePhotoCreate({ id: 'p1', markupId: 'm1', blob: new Blob(['x']), width: 1, height: 1 })
    await queueMarkupDelete('d1', 'm1')
    expect(await db.attachments.get('p1')).toBeUndefined()
    expect(await db.photoBlobs.where('attachment_id').equals('p1').count()).toBe(0)
    await drain()
    expect(sent.map(i => i.kind)).toEqual(['markup_delete'])
  })
  it('a 404 on photo_post is dropped silently, not failed', async () => {
    setSyncUser({ id: 'u1', name: 'U' })
    await queuePhotoCreate({ id: 'p1', markupId: 'm1', blob: new Blob(['x']), width: 1, height: 1 })
    configure({ executor: async () => { throw new ApiError(404, 'Not found') } })
    await drain()
    expect(await db.outbox.count()).toBe(0)
    expect(await db.attachments.get('p1')).toBeUndefined()
  })
})
