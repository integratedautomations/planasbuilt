import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Markup } from '../markups/types'
import { db } from './db'
import type { OutboxItem } from './db'
import { foreignInfo, foreignNotice } from './owner'
import { configure, discardForeign, drain, getSnapshot, queueMarkupPut, resetSyncState, setSyncUser } from './sync'

const mk = (id: string): Markup => ({
  id, document_id: 'd1', page: 1, type: 'device', geometry: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  style: { stroke: '#000', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }, text: '', layer_id: null,
})
const dana = { id: 'u-dana', name: 'Dana' }
const sam = { id: 'u-sam', name: 'Sam' }

let sent: OutboxItem[]
beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  resetSyncState()
  sent = []
  configure({ autoRetry: false, executor: async item => { sent.push(item); return {} } })
})

describe('foreignInfo', () => {
  it('ignores own and legacy items, counts the others', () => {
    const items = [{ userId: 'a', userName: 'Dana' }, { userId: 'a', userName: 'Dana' }, { userId: 'b', userName: 'Sam' }, {}]
    expect(foreignInfo(items, { id: 'b', name: 'Sam' })).toEqual({ count: 2, userId: 'a', name: 'Dana' })
    expect(foreignInfo(items, null)).toBeNull()
    expect(foreignInfo([{ userId: 'b' }, {}], { id: 'b', name: 'Sam' })).toBeNull()
  })
  it('words the notice', () => {
    expect(foreignNotice({ count: 3, userId: 'a', name: 'Dana' })).toBe('3 unsent changes from Dana: sign in as Dana to send them, or discard.')
    expect(foreignNotice({ count: 1, userId: 'a', name: 'Dana' })).toContain('1 unsent change from')
  })
})

describe('shared device', () => {
  it('stamps items with the signed-in user', async () => {
    setSyncUser(dana)
    await queueMarkupPut('d1', mk('a'))
    const [item] = await db.outbox.toArray()
    expect(item.userId).toBe('u-dana')
    expect(item.userName).toBe('Dana')
  })

  it('pauses when another user signs in, sends nothing, and resumes when the owner returns', async () => {
    setSyncUser(dana)
    await queueMarkupPut('d1', mk('a')) // autoRetry is off in tests, so it stays queued
    setSyncUser(sam)
    await drain()
    expect(sent).toHaveLength(0)
    expect(getSnapshot().foreign).toEqual({ count: 1, userId: 'u-dana', name: 'Dana' })

    setSyncUser(dana) // Dana signs back in
    await drain()
    expect(sent.map(i => i.targetId)).toEqual(['a'])
    expect(await db.outbox.count()).toBe(0)
    expect(getSnapshot().foreign).toBeNull()
  })

  it('keeps the whole queue paused, including the new users own items, until the notice is resolved', async () => {
    setSyncUser(dana)
    await queueMarkupPut('d1', mk('a'))
    setSyncUser(sam)
    await queueMarkupPut('d1', mk('b'))
    await drain()
    expect(sent).toHaveLength(0)
  })

  it('discard drops only the other users items and unpauses', async () => {
    setSyncUser(dana)
    await queueMarkupPut('d1', mk('a'))
    setSyncUser(sam)
    await queueMarkupPut('d1', mk('b'))
    await discardForeign()
    await drain()
    expect(sent.map(i => i.targetId)).toEqual(['b'])
    expect(await db.outbox.count()).toBe(0)
  })

  it('does not fold one user edit into another user queued item', async () => {
    setSyncUser(dana)
    await queueMarkupPut('d1', mk('a'))
    setSyncUser(sam)
    await queueMarkupPut('d1', { ...mk('a'), text: 'sam' })
    const items = await db.outbox.toArray()
    expect(items.map(i => i.userId)).toEqual(['u-dana', 'u-sam'])
  })
})
