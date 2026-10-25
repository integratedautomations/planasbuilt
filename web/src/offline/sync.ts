/**
 * Offline write path: local-first writes + an ordered outbox that is replayed to the server.
 *
 * ## Contract (for the live-sync work to build on)
 *
 * Writes
 *  - Call the `queue*` functions. Each one writes Dexie (so the UI/reload sees it at once) AND appends
 *    to `db.outbox` in a single transaction, then wakes the sync worker. Never call `api()` directly
 *    for a mutation that should work offline.
 *  - Calls are serialized (`writeChain`) so outbox order == call order even though callers are sync.
 *  - Coalescing (only against an item that is still `pending` and not in flight, for the same target):
 *      markup_put/photo_caption/photo_annotated/scale_put replace the queued payload;
 *      markup_delete drops a queued markup_put (the delete itself is still sent, it is idempotent);
 *      photo_delete cancels a photo that was never uploaded (no network traffic at all).
 *
 * Draining
 *  - `drain()` replays items in `seq` order, one at a time, while the network works.
 *      network / 5xx / 408 / 429  -> keep the item, bump attempts, stop, retry with backoff
 *      401                        -> stop, `authRequired` in the snapshot, resume with `resumeSync()`
 *      other 4xx                  -> item.status = 'failed' (visible in the UI), continue with the rest
 *    A 404 on a *_delete counts as success (server already doesn't have it).
 *  - On success the server row is "adopted" into Dexie (tag, version, who/when; photo row) and a
 *    `SyncEvent` is emitted so React state can follow.
 *
 * Observing
 *  - `subscribe(fn)`: SyncEvent stream ('markup-adopted', 'attachment-adopted', 'item-done',
 *    'auth-required', 'changed'). `getSnapshot()` + `subscribeSnapshot()` back `useSyncStatus()`.
 *  - `hasPending(targetId)` / `pendingMarkupIds(docId)`: tell whether a local row has unsent edits. Failed items
 *    do not count: they stay in the list for retry/discard but never freeze the row against remote changes.
 *
 * Live sync hook-in
 *  - A remote change (WebSocket push) should go through `applyRemoteMarkup(row)` /
 *    `applyRemoteMarkupDelete(docId, id)` / `mergeServerMarkups(docId, rows)`: they never clobber a
 *    markup that has unsent local edits (local wins until its outbox item is acknowledged), and emit
 *    'remote-markups' so useMarkups can refresh. Everything the outbox itself sends is idempotent
 *    (upsert by client id / soft delete / same photo id), so replays after a dropped connection are safe.
 */
import { api, ApiError } from '../api'
import type { Attachment } from '../api'
import type { Markup } from '../markups/types'
import { classifyError } from './classify'
import { db } from './db'
import { setLeaveGuard } from './leaveGuard'
import { requestPersistence } from './storagePersist'
import { loadLastSync, saveLastSync } from './unsent'
import { foreignInfo, isForeign } from './owner'
import type { CurrentUser, ForeignInfo } from './owner'
import type { AttachmentRow, OutboxItem, OutboxKind, ScaleRow } from './db'

// ---------------------------------------------------------------- events & snapshot

export type SyncEvent =
  | { type: 'markup-adopted'; docId: string; id: string; saved: Markup; sentTag: string }
  | { type: 'attachment-adopted'; attachment: Attachment; markupId: string }
  | { type: 'remote-markups'; docId: string; ids: string[] }
  | { type: 'item-done'; item: OutboxItem }
  | { type: 'auth-required' }
  | { type: 'changed' }

export interface SyncSnapshot {
  /** Browser says online AND the last request did not fail at the network level. */
  online: boolean
  /** Queued items that are still going to be sent (status 'pending'). */
  pending: number
  failed: number
  /** A request is in flight right now. */
  syncing: boolean
  authRequired: boolean
  /** Failed items (for the details list). */
  failedItems: OutboxItem[]
  /** Queued items from a different user than the one signed in: the queue is paused until they sign in again or discard. */
  foreign: ForeignInfo | null
  /** createdAt of the oldest unsent (pending or failed) item. */
  oldestAt: number | null
  /** When an item was last acknowledged by the server. */
  lastSyncAt: number | null
}

type Listener = (e: SyncEvent) => void
const listeners = new Set<Listener>()
export function subscribe(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } }
function emit(e: SyncEvent) { for (const l of [...listeners]) { try { l(e) } catch (err) { console.error(err) } } }

const snapListeners = new Set<() => void>()
export function subscribeSnapshot(fn: () => void) { snapListeners.add(fn); return () => { snapListeners.delete(fn) } }

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

let reachable = true
let syncing = false
let authRequired = false
let currentUser: CurrentUser | null = null
let lastSyncAt: number | null = loadLastSync()
let snapshot: SyncSnapshot = { online: true, pending: 0, failed: 0, syncing: false, authRequired: false, failedItems: [], foreign: null, oldestAt: null, lastSyncAt: loadLastSync() }

/** Tell the outbox who is signed in: new items are stamped with them; other users' items are never sent. */
export function setSyncUser(u: CurrentUser | null) {
  currentUser = u
  void refreshSnapshot()
  if (u) void drain()
}

/** Who the outbox currently works for (null = nobody signed in, so nothing is sent). */
export function getSyncUser() { return currentUser }

export function getSnapshot() { return snapshot }

/** Recompute the snapshot from Dexie and notify subscribers when something changed. */
export async function refreshSnapshot() {
  const [pendingItems, failedItems] = await Promise.all([
    db.outbox.where('status').equals('pending').toArray(),
    db.outbox.where('status').equals('failed').toArray(),
  ])
  const pending = pendingItems.length
  if (pending + failedItems.length > 0) void requestPersistence()
  const oldestAt = [...pendingItems, ...failedItems].reduce<number | null>((m, i) => m === null || i.createdAt < m ? i.createdAt : m, null)
  const next: SyncSnapshot = {
    online: reachable && browserOnline(), pending, failed: failedItems.length,
    syncing, authRequired, failedItems, foreign: foreignInfo(pendingItems, currentUser), oldestAt, lastSyncAt,
  }
  const p = snapshot
  const same = p.online === next.online && p.pending === next.pending && p.failed === next.failed &&
    p.oldestAt === next.oldestAt && p.lastSyncAt === next.lastSyncAt && p.syncing === next.syncing && p.authRequired === next.authRequired &&
    p.foreign?.count === next.foreign?.count && p.foreign?.userId === next.foreign?.userId &&
    p.failedItems.length === next.failedItems.length &&
    p.failedItems.every((f, i) => f.seq === next.failedItems[i].seq && f.lastError === next.failedItems[i].lastError)
  if (same) return
  snapshot = next
  for (const l of [...snapListeners]) l()
  emit({ type: 'changed' })
}

// ---------------------------------------------------------------- configuration (tests override)

export type Executor = (item: OutboxItem) => Promise<unknown>
let executor: Executor = defaultExecutor
let autoRetry = true

/** Test hook: swap the network executor and disable timers/event listeners driven retries. */
export type MarkupListFetcher = (docId: string) => Promise<Markup[]>
let fetchMarkupList: MarkupListFetcher = docId => api<Markup[]>(`/documents/${docId}/markups`)
export function configure(opts: { executor?: Executor; autoRetry?: boolean; fetchMarkups?: MarkupListFetcher }) {
  if (opts.executor) executor = opts.executor
  if (opts.fetchMarkups) fetchMarkupList = opts.fetchMarkups
  if (opts.autoRetry !== undefined) autoRetry = opts.autoRetry
}
/** Test hook: forget in-memory state. */
export function resetSyncState() {
  reachable = true; syncing = false; authRequired = false; inflightSeq = null; currentUser = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null; draining = null; rerun = false; skippedRemote.clear(); ackedAt.clear(); ackClock = 0
  snapshot = { online: true, pending: 0, failed: 0, syncing: false, authRequired: false, failedItems: [], foreign: null, oldestAt: null, lastSyncAt: null }
}

// ---------------------------------------------------------------- outbox writes

let inflightSeq: number | null = null
let writeChain: Promise<unknown> = Promise.resolve()

/** Resolves when every local write queued so far has reached Dexie. */
export const flushWrites = () => writeChain.then(() => {})

/** Serialize local writes so outbox order matches call order. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => {})
  return run
}

const REPLACE_KINDS: ReadonlySet<OutboxKind> = new Set(['markup_put', 'photo_caption', 'photo_annotated', 'scale_put'])

/**
 * Append to the outbox, coalescing against the newest item for the same target.
 * MUST run inside a transaction that includes `db.outbox`. Exported for tests.
 */
export async function addToOutbox(input: Pick<OutboxItem, 'kind' | 'docId' | 'targetId' | 'payload'>): Promise<number> {
  const last = await db.outbox.where('targetId').equals(input.targetId).last()
  // Never fold this user's edit into an item another user queued: ownership must stay with the author.
  if (last && last.status === 'pending' && last.seq !== inflightSeq && !isForeign(last, currentUser)) {
    if (last.kind === input.kind && REPLACE_KINDS.has(input.kind)) {
      const payload = input.kind === 'markup_put' ? carryPutMeta(last.payload, input.payload) : input.payload
      await db.outbox.update(last.seq!, { payload, attempts: 0, lastError: '' })
      return last.seq!
    }
    if (input.kind === 'markup_delete' && last.kind === 'markup_put') await db.outbox.delete(last.seq!)
  }
  return (await db.outbox.add({
    ...input, attempts: 0, lastError: '', status: 'pending', createdAt: Date.now(),
    ...(currentUser ? { userId: currentUser.id, userName: currentUser.name } : {}),
  })) as number
}

/**
 * Folding a newer markup_put into a queued one keeps what the queued one knew about the server: the version the
 * edits are based on (the oldest one counts) and an explicit restore.
 */
export function carryPutMeta(prev: any, next: any) {
  const out = { ...next }
  const base = typeof prev?.base_version === 'number' ? prev.base_version : next?.base_version
  if (typeof base === 'number') out.base_version = base
  if (prev?.restore === true || next?.restore === true) out.restore = true
  return out
}

function afterWrite() {
  void refreshSnapshot()
  kick()
}

/** The JSON body the server's markup PUT expects. */
export function markupBody(m: Markup) {
  return {
    page: m.page, type: m.type, geometry: m.geometry, style: m.style, text: m.text,
    layer_id: m.layer_id, symbol_set_id: m.symbol_set_id ?? null, device_type_id: m.device_type_id ?? null, product_id: m.product_id ?? null, tag: m.tag ?? '',
    status: m.status ?? '', fields: m.fields ?? {},
  }
}

/**
 * Save a markup locally and queue the PUT. The body carries `base_version` (the server version this edit was made
 * on top of) so the server can refuse to resurrect a markup deleted meanwhile or undo a page move/rotation.
 * `restore` = the user explicitly brings the markup back (undo of a delete / redo of a create): never refused.
 */
export function queueMarkupPut(docId: string, m: Markup, opts: { restore?: boolean } = {}) {
  return serial(async () => {
    await db.transaction('rw', db.markups, db.outbox, async () => {
      const prev = await db.markups.get(m.id)
      const base = prev?.version ?? m.version
      await db.markups.put(m)
      await addToOutbox({
        kind: 'markup_put', docId, targetId: m.id,
        payload: { ...markupBody(m), ...(typeof base === 'number' ? { base_version: base } : {}), ...(opts.restore ? { restore: true } : {}) },
      })
    })
    afterWrite()
  })
}

/**
 * A markup is being deleted: photos of it that were never uploaded (or only wait to upload an
 * annotation) have no parent to attach to any more, so drop their queued work and local rows.
 * A photo whose upload is in flight right now is left alone (the server answer / 404 path handles it).
 * Must run inside a transaction that includes outbox, attachments and photoBlobs.
 */
async function cancelPhotosOf(markupId: string) {
  const ids = new Set((await db.attachments.where('markup_id').equals(markupId).toArray()).filter(a => a.pending).map(a => a.id))
  for (const i of await db.outbox.toArray())
    if (i.kind === 'photo_post' && i.payload?.markupId === markupId) ids.add(i.targetId)
  for (const attId of ids) {
    const items = await db.outbox.where('targetId').equals(attId).toArray()
    if (items.some(i => i.seq === inflightSeq)) continue
    await db.outbox.bulkDelete(items.map(i => i.seq!))
    await db.attachments.delete(attId)
    await db.photoBlobs.where('attachment_id').equals(attId).delete()
  }
}

export function queueMarkupDelete(docId: string, id: string) {
  return serial(async () => {
    await db.transaction('rw', db.markups, db.attachments, db.photoBlobs, db.outbox, async () => {
      await db.markups.delete(id)
      await cancelPhotosOf(id)
      await addToOutbox({ kind: 'markup_delete', docId, targetId: id, payload: null })
    })
    afterWrite()
  })
}

/** Photo taken (possibly offline): keep the bytes locally, show them at once, upload later. */
export function queuePhotoCreate(p: { id: string; markupId: string; blob: Blob; width: number; height: number }) {
  return serial(async () => {
    await db.transaction('rw', db.attachments, db.photoBlobs, db.outbox, async () => {
      const row: AttachmentRow = {
        id: p.id, markup_id: p.markupId, caption: '', width: p.width, height: p.height,
        created_at: new Date().toISOString(), created_by: '', has_annotation: false, pending: true,
      }
      await db.attachments.put(row)
      const now = Date.now()
      await db.photoBlobs.bulkPut([
        { key: `${p.id}:original`, attachment_id: p.id, variant: 'original', blob: p.blob, cachedAt: now },
        { key: `${p.id}:view`, attachment_id: p.id, variant: 'view', blob: p.blob, cachedAt: now },
      ])
      await addToOutbox({ kind: 'photo_post', docId: '', targetId: p.id, payload: { markupId: p.markupId } })
    })
    afterWrite()
  })
}

export function queuePhotoAnnotated(id: string, blob: Blob) {
  return serial(async () => {
    await db.transaction('rw', db.attachments, db.photoBlobs, db.outbox, async () => {
      const now = Date.now()
      await db.photoBlobs.bulkPut([
        { key: `${id}:annotated`, attachment_id: id, variant: 'annotated', blob, cachedAt: now },
        { key: `${id}:view`, attachment_id: id, variant: 'view', blob, cachedAt: now },
      ])
      await db.attachments.update(id, { has_annotation: true })
      await addToOutbox({ kind: 'photo_annotated', docId: '', targetId: id, payload: null })
    })
    afterWrite()
  })
}

export function queuePhotoCaption(id: string, caption: string) {
  return serial(async () => {
    await db.transaction('rw', db.attachments, db.outbox, async () => {
      await db.attachments.update(id, { caption })
      await addToOutbox({ kind: 'photo_caption', docId: '', targetId: id, payload: { caption } })
    })
    afterWrite()
  })
}

export function queuePhotoDelete(id: string) {
  return serial(async () => {
    await db.transaction('rw', db.attachments, db.photoBlobs, db.outbox, async () => {
      const mine = await db.outbox.where('targetId').equals(id).toArray()
      const neverSent = mine.length > 0 && mine[0].kind === 'photo_post' && mine[0].seq !== inflightSeq
      await db.attachments.delete(id)
      await db.photoBlobs.where('attachment_id').equals(id).delete()
      if (neverSent) await db.outbox.bulkDelete(mine.map(i => i.seq!))
      else await addToOutbox({ kind: 'photo_delete', docId: '', targetId: id, payload: null })
    })
    afterWrite()
  })
}

export function queueScalePut(docId: string, pages: number[], body: { points_per_foot: number; label: string }) {
  return serial(async () => {
    await db.transaction('rw', db.scales, db.outbox, async () => {
      await db.scales.bulkPut(pages.map<ScaleRow>(page => ({ key: `${docId}:${page}`, document_id: docId, page, ...body })))
      await addToOutbox({ kind: 'scale_put', docId, targetId: `${docId}:scale:${pages.join(',')}`, payload: { pages, ...body } })
    })
    afterWrite()
  })
}

export function queueScaleDelete(docId: string, page: number) {
  return serial(async () => {
    await db.transaction('rw', db.scales, db.outbox, async () => {
      await db.scales.delete(`${docId}:${page}`)
      await addToOutbox({ kind: 'scale_delete', docId, targetId: `${docId}:scale:${page}`, payload: { page } })
    })
    afterWrite()
  })
}

// ---------------------------------------------------------------- queries

/** True while something for this target is still going to be sent. Failed items (waiting for retry/discard) do not count. */
export async function hasPending(targetId: string) {
  return (await db.outbox.where('targetId').equals(targetId).filter(i => i.status === 'pending').count()) > 0
}

/** Ids of markups in `docId` with unsent local changes (put or delete). Failed items do not count. */
export async function pendingMarkupIds(docId: string): Promise<Set<string>> {
  const items = await db.outbox.where('docId').equals(docId).toArray()
  return new Set(items.filter(i => i.status === 'pending' && (i.kind === 'markup_put' || i.kind === 'markup_delete')).map(i => i.targetId))
}

/** Ids of markups in `docId` whose save failed for good (kept visible for retry/discard). */
export async function failedMarkupIds(docId: string): Promise<Set<string>> {
  const items = await db.outbox.where('docId').equals(docId).toArray()
  return new Set(items.filter(i => i.status === 'failed' && i.kind === 'markup_put').map(i => i.targetId))
}

// ---------------------------------------------------------------- acknowledgements

/**
 * Per-markup "the server acknowledged our write" counter. A list fetched from the server may have been computed
 * before one of our writes landed; taking `ackSnapshot()` before the request and asking `ackedSince` afterwards
 * tells which markups changed under it, so the older list does not overwrite them (the outbox item is already
 * gone by then, so the outbox alone cannot tell).
 */
let ackClock = 0
const ackedAt = new Map<string, number>()
const ACK_KEEP = 5000

export function ackSnapshot(): number { return ackClock }
export function ackedSince(id: string, snapshot: number): boolean { return (ackedAt.get(id) ?? 0) > snapshot }
function noteAck(id: string) {
  ackedAt.delete(id)
  ackedAt.set(id, ++ackClock)
  if (ackedAt.size > ACK_KEEP) for (const k of ackedAt.keys()) { ackedAt.delete(k); if (ackedAt.size <= ACK_KEEP * 0.8) break }
}

// ---------------------------------------------------------------- server data -> Dexie (read & live sync)

/**
 * Decide what a server list does to the local copy (pure).
 *  - a server row replaces the local one, except when the markup has unsent edits (`pending`), was acknowledged after
 *    the list was requested (`acked`), or the local row is already newer than the server's;
 *  - a local row the server does not list is removed, except when it is pending/acked or its save failed (`failed`:
 *    it never reached the server, so absence says nothing; it stays for retry/discard).
 */
export function planMerge(
  local: Map<string, Markup>, rows: Markup[], pending: Set<string>, failed: Set<string>, acked: (id: string) => boolean,
): { put: Markup[]; remove: string[] } {
  const protectedId = (id: string) => pending.has(id) || acked(id)
  const listed = new Set(rows.map(r => r.id))
  const put = rows.filter(r => {
    if (protectedId(r.id)) return false
    const mine = local.get(r.id)
    return !(mine && (mine.version ?? 0) > (r.version ?? 0))
  })
  const remove = [...local.keys()].filter(id => !listed.has(id) && !protectedId(id) && !failed.has(id))
  return { put, remove }
}

/**
 * Merge the server's list of a document's markups into Dexie, keeping markups that have unsent local edits,
 * were acknowledged since `ackSince` (take it with `ackSnapshot()` before requesting the list) or are newer locally.
 * Returns the resulting local list.
 */
export async function mergeServerMarkups(docId: string, rows: Markup[], ackSince?: number): Promise<Markup[]> {
  return db.transaction('rw', db.markups, db.outbox, async () => {
    const pending = await pendingMarkupIds(docId)
    const failed = await failedMarkupIds(docId)
    const local = new Map((await db.markups.where('document_id').equals(docId).toArray()).map(m => [m.id, m]))
    const plan = planMerge(local, rows, pending, failed, id => ackSince !== undefined && ackedSince(id, ackSince))
    await db.markups.bulkDelete(plan.remove)
    await db.markups.bulkPut(plan.put)
    return db.markups.where('document_id').equals(docId).toArray()
  })
}

/** Ids whose remote change was ignored because of unsent local edits; reconciled with the server once those are sent. */
const skippedRemote = new Map<string, string>()

/** Live sync: a markup was created/changed elsewhere. Ignored while we hold unsent edits for it (and re-checked later). */
export async function applyRemoteMarkup(row: Markup): Promise<boolean> {
  const applied = await db.transaction('rw', db.markups, db.outbox, async () => {
    if (await hasPending(row.id)) { skippedRemote.set(row.id, row.document_id); return false }
    await db.markups.put(row)
    return true
  })
  if (applied) emit({ type: 'remote-markups', docId: row.document_id, ids: [row.id] })
  return applied
}

export async function applyRemoteMarkupDelete(docId: string, id: string): Promise<boolean> {
  const applied = await db.transaction('rw', db.markups, db.outbox, async () => {
    if (await hasPending(id)) { skippedRemote.set(id, docId); return false }
    await db.markups.delete(id)
    return true
  })
  if (applied) emit({ type: 'remote-markups', docId, ids: [id] })
  return applied
}

/**
 * After our own queued edit of a markup is done, catch up on remote changes we ignored meanwhile:
 * refetch the document's markups; if the server no longer has it remove it locally, otherwise take
 * the server row when its version is newer than ours.
 */
async function reconcileSkipped(id: string) {
  const docId = skippedRemote.get(id)
  if (!docId || (await hasPending(id))) return
  skippedRemote.delete(id)
  let rows: Markup[]
  const acked = ackSnapshot()
  try { rows = await fetchMarkupList(docId) } catch { skippedRemote.set(id, docId); return } // retried after the next item
  const server = rows.find(r => r.id === id)
  const changed = await db.transaction('rw', db.markups, db.outbox, async () => {
    if (await hasPending(id)) { skippedRemote.set(id, docId); return false }
    if (ackedSince(id, acked)) return false // our own write landed after the list was requested
    const local = await db.markups.get(id)
    if (!server) { if (!local) return false; await db.markups.delete(id); return true }
    if (!local || (server.version ?? 0) > (local.version ?? 0)) { await db.markups.put(server); return true }
    return false
  })
  if (changed) emit({ type: 'remote-markups', docId, ids: [id] })
}

// ---------------------------------------------------------------- executors (network)

function photoForm(fields: Record<string, string>, blob: Blob, name: string) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('photo', blob, name) // file part last so the server sees fields first
  return fd
}

async function defaultExecutor(item: OutboxItem): Promise<unknown> {
  const { kind, docId, targetId: id, payload } = item
  switch (kind) {
    case 'markup_put': {
      // Photos taken offline are queued behind this save; tell the server so a "photo required" status is not refused for them.
      const queuedPhotos = await db.outbox.filter(i => i.kind === 'photo_post' && i.status !== 'failed' && i.payload?.markupId === id).count()
      const body = queuedPhotos > 0 ? { ...payload, pending_photos: queuedPhotos } : payload
      return api<Markup>(`/documents/${docId}/markups/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    }
    case 'markup_delete':
      return api(`/documents/${docId}/markups/${id}`, { method: 'DELETE' })
    case 'photo_post': {
      const meta = await db.attachments.get(id)
      const blob = (await db.photoBlobs.get(`${id}:original`))?.blob
      if (!meta || !blob) throw new ApiError(410, 'Photo data is missing on this device')
      const fd = photoForm({
        id, caption: meta.caption, width: String(meta.width), height: String(meta.height),
      }, blob, 'photo.jpg')
      return api<Attachment>(`/markups/${payload.markupId}/attachments`, { method: 'POST', body: fd })
    }
    case 'photo_annotated': {
      const blob = (await db.photoBlobs.get(`${id}:annotated`))?.blob
      if (!blob) throw new ApiError(410, 'Annotated photo is missing on this device')
      return api(`/attachments/${id}/annotated`, { method: 'PUT', body: photoForm({}, blob, 'annotated.jpg') })
    }
    case 'photo_caption':
      return api(`/attachments/${id}`, { method: 'PATCH', body: JSON.stringify({ caption: payload.caption }) })
    case 'photo_delete':
      return api(`/attachments/${id}`, { method: 'DELETE' })
    case 'scale_put': {
      const body = { points_per_foot: payload.points_per_foot, label: payload.label }
      const pages: number[] = payload.pages
      return pages.length === 1
        ? api(`/documents/${docId}/scales/${pages[0]}`, { method: 'PUT', body: JSON.stringify(body) })
        : api(`/documents/${docId}/scales`, { method: 'PUT', body: JSON.stringify({ ...body, pages }) })
    }
    case 'scale_delete':
      return api(`/documents/${docId}/scales/${payload.page}`, { method: 'DELETE' })
  }
}

// ---------------------------------------------------------------- adoption of server answers

async function adopt(item: OutboxItem, result: unknown) {
  if (item.kind === 'markup_put') {
    const saved = result as Markup
    if (!saved || typeof saved !== 'object') return
    const sentTag: string = item.payload?.tag ?? ''
    await db.transaction('rw', db.markups, async () => {
      const local = await db.markups.get(item.targetId)
      if (!local) return // deleted locally in the meantime
      const { version, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at } = saved
      // Server-assigned tag (CAM-07): fill it in, but never overwrite a tag the user has since changed.
      const tag = saved.tag && (!local.tag || local.tag === sentTag) ? saved.tag : local.tag
      await db.markups.put({ ...local, tag, version, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at })
    })
    // Edits queued behind this one were made on top of it: they are based on the version just saved.
    if (typeof saved.version === 'number') {
      await db.outbox.where('targetId').equals(item.targetId)
        .filter(i => i.kind === 'markup_put' && i.seq !== item.seq && i.payload && !i.payload.restore)
        .modify(i => { i.payload = { ...i.payload, base_version: saved.version } })
    }
    emit({ type: 'markup-adopted', docId: item.docId, id: item.targetId, saved, sentTag })
  } else if (item.kind === 'photo_post') {
    const rec = result as Attachment
    await db.transaction('rw', db.attachments, db.photoBlobs, async () => {
      const local = await db.attachments.get(item.targetId)
      if (!local) return // deleted locally while uploading; photo_delete follows in the outbox
      // Keep a caption/annotation flag the user changed while the upload was in flight
      await db.attachments.put({ ...rec, caption: local.caption, has_annotation: rec.has_annotation || local.has_annotation, pending: false })
    })
    emit({ type: 'attachment-adopted', attachment: rec, markupId: item.payload.markupId })
  } else if (item.kind === 'photo_annotated') {
    // Next queued annotation (if any) will re-store its own blob; 'view' keeps showing the annotated image.
    if (!(await db.outbox.where('targetId').equals(item.targetId).filter(i => i.kind === 'photo_annotated' && i.seq !== item.seq).count()))
      await db.photoBlobs.delete(`${item.targetId}:annotated`)
  }
}

// ---------------------------------------------------------------- the worker

let draining: Promise<void> | null = null
let rerun = false
let retryTimer: ReturnType<typeof setTimeout> | null = null

export const backoffMs = (attempts: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1))

/** Start (or ask for another pass of) the worker. Resolves when the queue is empty or stopped. */
export function drain(): Promise<void> {
  if (draining) { rerun = true; return draining }
  draining = (async () => {
    do { rerun = false; await drainOnce() } while (rerun)
  })().finally(() => { draining = null })
  return draining
}

async function drainOnce() {
  if (authRequired) return
  // Nobody known yet (app start, sign-in in progress): sending now could run under the wrong account.
  if (!currentUser) { await refreshSnapshot(); return }
  if (!browserOnline()) { await refreshSnapshot(); return }
  for (;;) {
    // Pick the next item and mark it in flight in ONE transaction: queue writes (which coalesce into the
    // newest not-in-flight item) either land before we read, or see inflightSeq and append instead.
    let item = undefined as OutboxItem | undefined
    let paused = false as boolean
    await db.transaction('rw', db.outbox, async () => {
      const queue = await db.outbox.where('status').equals('pending').toArray()
      // Shared device: never send another user's queued work under this account. Pause everything.
      if (queue.some(i => isForeign(i, currentUser))) { paused = true; return }
      item = queue[0]
      if (item) inflightSeq = item.seq!
    })
    if (paused || !item) break
    syncing = true
    await refreshSnapshot()
    let result: unknown
    try {
      result = await executor(item)
    } catch (e) {
      inflightSeq = null; syncing = false
      const msg = (e instanceof ApiError && e.status === 423) ? 'This company is archived, so changes can no longer be saved' : ((e as Error).message || 'Request failed')
      const cls = classifyError(e)
      const treatAsDone = cls === 'permanent' && (e as ApiError).status === 404 && item.kind.endsWith('_delete')
      if (treatAsDone) { await finish(item, undefined); continue }
      // The server refused to overwrite a markup that was deleted / moved / rotated after the version this edit was based on.
      if (cls === 'permanent' && (e as ApiError).status === 409 && item.kind === 'markup_put' && (e as ApiError).body?.conflict && (e as ApiError).body.current) {
        try { await resolveConflict(item, (e as ApiError).body.current); continue } catch (err) { console.error('conflict handling failed', err) }
      }
      // The markup the photo belonged to is gone on the server: nothing to attach to, drop the photo quietly.
      // But while a save of that markup is still in the outbox (failed or not) the 404 only means it never got there:
      // keep the photo (marked failed below, so the user can retry it once the markup is saved).
      if (cls === 'permanent' && (e as ApiError).status === 404 && item.kind === 'photo_post' && !(await hasMarkupPut(item.payload?.markupId))) { await dropPhoto(item); continue }
      const attempts = item.attempts + 1
      if (cls === 'permanent') {
        await db.outbox.update(item.seq!, { status: 'failed', attempts, lastError: msg })
        await refreshSnapshot()
        continue
      }
      await db.outbox.update(item.seq!, { attempts, lastError: msg })
      if (cls === 'auth') {
        authRequired = true
        emit({ type: 'auth-required' })
      } else {
        if (cls === 'network') reachable = false
        scheduleRetry(backoffMs(attempts))
      }
      await refreshSnapshot()
      return
    }
    inflightSeq = null; syncing = false
    reachable = true
    await finish(item, result)
  }
  await refreshSnapshot()
}

async function finish(item: OutboxItem, result: unknown) {
  // Note the acknowledgement BEFORE the outbox item disappears, so a concurrent merge sees one or the other.
  if (item.kind === 'markup_put' || item.kind === 'markup_delete') noteAck(item.targetId)
  try { await adopt(item, result) } catch (e) { console.error('adopt failed', e) }
  // Only drop what we actually sent: if the stored item changed meanwhile, keep it to be sent again.
  const cur = await db.outbox.get(item.seq!)
  if (cur && JSON.stringify(cur.payload) !== JSON.stringify(item.payload)) await db.outbox.update(item.seq!, { attempts: 0, lastError: '' })
  else await db.outbox.delete(item.seq!)
  lastSyncAt = Date.now(); saveLastSync(lastSyncAt)
  emit({ type: 'item-done', item })
  if (item.kind === 'markup_put' || item.kind === 'markup_delete') {
    try { await reconcileSkipped(item.targetId) } catch (e) { console.error('reconcile failed', e) }
  }
  await refreshSnapshot()
}

/** Is a save of this markup still in the outbox (pending or failed)? */
async function hasMarkupPut(markupId: string | undefined) {
  if (!markupId) return false
  return (await db.outbox.where('targetId').equals(markupId).filter(i => i.kind === 'markup_put').count()) > 0
}

const MAX_CONFLICT_RETRIES = 5

/**
 * The server refused a markup_put (409 conflict, `current` = its row now). If the markup was deleted there, our edit
 * cannot apply: drop it and the local row. If a page operation moved/rotated it, take the server's page and geometry and
 * keep everything else the user changed (text, style, status, fields, photos...), then send it again on top of that.
 */
async function resolveConflict(item: OutboxItem, current: Markup & { deleted?: boolean }) {
  const id = item.targetId
  await db.transaction('rw', db.markups, db.outbox, async () => {
    const siblings = (await db.outbox.where('targetId').equals(id).toArray()).filter(i => i.kind === 'markup_put' && i.seq !== item.seq)
    if (current.deleted) {
      await db.outbox.bulkDelete([item.seq!, ...siblings.map(i => i.seq!)])
      await db.markups.delete(id)
      return
    }
    const local = await db.markups.get(id)
    const { deleted: _deleted, ...server } = current
    await db.markups.put(local
      ? { ...local, page: server.page, geometry: server.geometry, version: server.version, updated_by: server.updated_by, updated_by_name: server.updated_by_name, updated_at: server.updated_at }
      : server as Markup)
    const fix = (p: any) => ({ ...p, page: server.page, geometry: server.geometry, base_version: server.version })
    for (const s of siblings) await db.outbox.update(s.seq!, { payload: fix(s.payload) })
    const attempts = item.attempts + 1
    if (attempts >= MAX_CONFLICT_RETRIES)
      await db.outbox.update(item.seq!, { status: 'failed', attempts, lastError: 'The plan keeps changing under this markup' })
    else await db.outbox.update(item.seq!, { payload: fix(item.payload), attempts, lastError: '' })
  })
  noteAck(id)
  emit({ type: 'remote-markups', docId: item.docId, ids: [id] })
  await refreshSnapshot()
}

/** Remove a photo (and everything queued for it) whose parent markup no longer exists. */
async function dropPhoto(item: OutboxItem) {
  await db.transaction('rw', db.attachments, db.photoBlobs, db.outbox, async () => {
    const items = await db.outbox.where('targetId').equals(item.targetId).toArray()
    await db.outbox.bulkDelete(items.map(i => i.seq!))
    await db.attachments.delete(item.targetId)
    await db.photoBlobs.where('attachment_id').equals(item.targetId).delete()
  })
  emit({ type: 'item-done', item })
  await refreshSnapshot()
}

function scheduleRetry(ms: number) {
  if (!autoRetry || typeof setTimeout === 'undefined') return
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => { retryTimer = null; void drain() }, ms)
}

/** Wake the worker (after a write, on reconnect, on tab focus). */
export function kick() {
  if (!autoRetry) return
  if (retryTimer && !reachable) return // backing off; the timer or an 'online' event will wake us
  void drain()
}

/** After the user signs in again following a 401. */
export function resumeSync() {
  authRequired = false
  reachable = true
  void drain()
}

export async function retryItem(seq: number) {
  const item = await db.outbox.get(seq)
  await db.outbox.update(seq, { status: 'pending', attempts: 0, lastError: '' })
  // Photos that were waiting for this markup to be saved get another go too.
  if (item?.kind === 'markup_put')
    await db.outbox.where('status').equals('failed').filter(i => i.kind === 'photo_post' && i.payload?.markupId === item.targetId)
      .modify({ status: 'pending', attempts: 0, lastError: '' })
  reachable = true
  await refreshSnapshot()
  void drain()
}
export async function retryAllFailed() {
  await db.outbox.where('status').equals('failed').modify({ status: 'pending', attempts: 0, lastError: '' })
  reachable = true
  await refreshSnapshot()
  void drain()
}
/**
 * Drop a queued write. The local Dexie row keeps the unsent change until the next server refresh
 * replaces it (mergeServerMarkups only protects rows that still have outbox items).
 */
export async function discardItem(seq: number) {
  await db.outbox.delete(seq)
  await refreshSnapshot()
}
/** Throw away queued changes that belong to other users (the notice's "discard"). */
export async function discardForeign() {
  const all = await db.outbox.toArray()
  await db.outbox.bulkDelete(all.filter(i => isForeign(i, currentUser)).map(i => i.seq!))
  await refreshSnapshot()
  void drain()
}
export async function discardAllFailed() {
  await db.outbox.where('status').equals('failed').delete()
  await refreshSnapshot()
}

let started = false
/** Call once at app start: wires window events and drains whatever a previous session left behind. */
export function startSync() {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('online', () => { reachable = true; void refreshSnapshot(); void drain() })
  window.addEventListener('offline', () => { void refreshSnapshot() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { reachable = true; void drain() } })
  window.addEventListener('planmark:signed-out', () => { authRequired = true; void refreshSnapshot() })
  subscribeSnapshot(() => setLeaveGuard(snapshot.pending > 0 || snapshot.syncing))
  void refreshSnapshot()
  void drain()
}
