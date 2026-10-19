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
 *  - `hasPending(targetId)` / `pendingMarkupIds(docId)`: tell whether a local row has unsent edits.
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
let snapshot: SyncSnapshot = { online: true, pending: 0, failed: 0, syncing: false, authRequired: false, failedItems: [], foreign: null }

/** Tell the outbox who is signed in: new items are stamped with them; other users' items are never sent. */
export function setSyncUser(u: CurrentUser | null) {
  currentUser = u
  void refreshSnapshot()
  if (u) void drain()
}

export function getSnapshot() { return snapshot }

/** Recompute the snapshot from Dexie and notify subscribers when something changed. */
export async function refreshSnapshot() {
  const [pendingItems, failedItems] = await Promise.all([
    db.outbox.where('status').equals('pending').toArray(),
    db.outbox.where('status').equals('failed').toArray(),
  ])
  const pending = pendingItems.length
  const next: SyncSnapshot = {
    online: reachable && browserOnline(), pending, failed: failedItems.length,
    syncing, authRequired, failedItems, foreign: foreignInfo(pendingItems, currentUser),
  }
  const p = snapshot
  const same = p.online === next.online && p.pending === next.pending && p.failed === next.failed &&
    p.syncing === next.syncing && p.authRequired === next.authRequired &&
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
export function configure(opts: { executor?: Executor; autoRetry?: boolean }) {
  if (opts.executor) executor = opts.executor
  if (opts.autoRetry !== undefined) autoRetry = opts.autoRetry
}
/** Test hook: forget in-memory state. */
export function resetSyncState() {
  reachable = true; syncing = false; authRequired = false; inflightSeq = null; currentUser = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null; draining = null; rerun = false
  snapshot = { online: true, pending: 0, failed: 0, syncing: false, authRequired: false, failedItems: [], foreign: null }
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
      await db.outbox.update(last.seq!, { payload: input.payload, attempts: 0, lastError: '' })
      return last.seq!
    }
    if (input.kind === 'markup_delete' && last.kind === 'markup_put') await db.outbox.delete(last.seq!)
  }
  return (await db.outbox.add({
    ...input, attempts: 0, lastError: '', status: 'pending', createdAt: Date.now(),
    ...(currentUser ? { userId: currentUser.id, userName: currentUser.name } : {}),
  })) as number
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

export function queueMarkupPut(docId: string, m: Markup) {
  return serial(async () => {
    await db.transaction('rw', db.markups, db.outbox, async () => {
      await db.markups.put(m)
      await addToOutbox({ kind: 'markup_put', docId, targetId: m.id, payload: markupBody(m) })
    })
    afterWrite()
  })
}

export function queueMarkupDelete(docId: string, id: string) {
  return serial(async () => {
    await db.transaction('rw', db.markups, db.outbox, async () => {
      await db.markups.delete(id)
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

export async function hasPending(targetId: string) {
  return (await db.outbox.where('targetId').equals(targetId).count()) > 0
}

/** Ids of markups in `docId` with unsent local changes (put or delete). */
export async function pendingMarkupIds(docId: string): Promise<Set<string>> {
  const items = await db.outbox.where('docId').equals(docId).toArray()
  return new Set(items.filter(i => i.kind === 'markup_put' || i.kind === 'markup_delete').map(i => i.targetId))
}

// ---------------------------------------------------------------- server data -> Dexie (read & live sync)

/**
 * Replace Dexie's copy of a document's markups with the server's list, except markups that have
 * unsent local edits. Returns the resulting local list.
 */
export async function mergeServerMarkups(docId: string, rows: Markup[]): Promise<Markup[]> {
  return db.transaction('rw', db.markups, db.outbox, async () => {
    const pending = await pendingMarkupIds(docId)
    const keep = new Set(rows.map(r => r.id))
    const stale = (await db.markups.where('document_id').equals(docId).primaryKeys()).filter(id => !keep.has(id) && !pending.has(id))
    await db.markups.bulkDelete(stale)
    await db.markups.bulkPut(rows.filter(r => !pending.has(r.id)))
    return db.markups.where('document_id').equals(docId).toArray()
  })
}

/** Live sync: a markup was created/changed elsewhere. Ignored while we hold unsent edits for it. */
export async function applyRemoteMarkup(row: Markup): Promise<boolean> {
  const applied = await db.transaction('rw', db.markups, db.outbox, async () => {
    if (await hasPending(row.id)) return false
    await db.markups.put(row)
    return true
  })
  if (applied) emit({ type: 'remote-markups', docId: row.document_id, ids: [row.id] })
  return applied
}

export async function applyRemoteMarkupDelete(docId: string, id: string): Promise<boolean> {
  const applied = await db.transaction('rw', db.markups, db.outbox, async () => {
    if (await hasPending(id)) return false
    await db.markups.delete(id)
    return true
  })
  if (applied) emit({ type: 'remote-markups', docId, ids: [id] })
  return applied
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
    case 'markup_put':
      return api<Markup>(`/documents/${docId}/markups/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
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
  if (!browserOnline()) { await refreshSnapshot(); return }
  for (;;) {
    // Shared device: never send another user's queued work under this account. Pause everything.
    const queue = await db.outbox.where('status').equals('pending').toArray()
    if (queue.some(i => isForeign(i, currentUser))) break
    const item = queue[0]
    if (!item) break
    inflightSeq = item.seq!
    syncing = true
    await refreshSnapshot()
    let result: unknown
    try {
      result = await executor(item)
    } catch (e) {
      inflightSeq = null; syncing = false
      const msg = (e as Error).message || 'Request failed'
      const cls = classifyError(e)
      const treatAsDone = cls === 'permanent' && (e as ApiError).status === 404 && item.kind.endsWith('_delete')
      if (treatAsDone) { await finish(item, undefined); continue }
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
  try { await adopt(item, result) } catch (e) { console.error('adopt failed', e) }
  await db.outbox.delete(item.seq!)
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
  await db.outbox.update(seq, { status: 'pending', attempts: 0, lastError: '' })
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
  void refreshSnapshot()
  void drain()
}
