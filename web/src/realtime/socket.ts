/**
 * Live sync connection (singleton). One WebSocket per tab to /api/ws, one room (document) at a time.
 *
 *  - connects whenever there is a token and the browser is online; reconnects with backoff (1s -> 30s + jitter)
 *  - after every (re)connect while in a document: re-join, then catch up (refetch markups through
 *    mergeServerMarkups; scales/layers/symbol sets/photos are refetched by their owners via synthetic events)
 *  - server data messages are applied to Dexie (markups) and then fanned out to `on(type, fn)` listeners
 *  - close code 4401 (bad token) takes the same path as a REST 401: `signalAuthExpired()`
 *  - `disconnect()` closes the socket (sign-out), so the next user's `connect()` opens a fresh one as themselves
 *  - the catch-up request has a timeout; a stuck one cannot hold up the other messages for more than that
 */
import { getToken, signalAuthExpired } from '../api'
import { getActiveCompanyId } from '../company/activeCompany'
import { loadMarkups } from '../offline/cache'
import { getClientId } from './clientId'
import { applyServerMessage } from './handlers'
import { createPresenceThrottle, reducePeers } from './presence'
import type { Peer, PresenceOut } from './presence'

export type SocketStatus = 'idle' | 'live' | 'reconnecting'

/** Delay before reconnect attempt number `attempt` (0-based): 1s, 2s, 4s ... capped at 30s, plus up to 25% jitter. */
export function reconnectDelay(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))
  return Math.round(base + base * 0.25 * rand)
}

export const PING_MS = 25_000
const STALE_MS = 70_000
/** The catch-up of one (re)join may hold up other messages for this long at most. */
export const CATCHUP_TIMEOUT_MS = 10_000
/** After a failed/timed out catch-up: tries again this many times, this much later each time. */
const CATCHUP_RETRIES = 3
const CATCHUP_RETRY_MS = 4_000

type Fn = (msg: any) => void

interface Hooks {
  /** Refetch what was missed while disconnected; resolves when local data is merged. `signal` aborts the request on timeout. */
  catchUp: (docId: string, signal?: AbortSignal) => Promise<void>
  presenceIntervalMs: number
  catchUpTimeoutMs: number
}
const hooks: Hooks = {
  catchUp: async (docId, signal) => {
    await loadMarkups(docId, signal)
    // An aborted request falls back to the local copy inside loadMarkups: that is not a catch-up.
    if (signal?.aborted) throw new Error('catch-up timed out')
  },
  presenceIntervalMs: 100,
  catchUpTimeoutMs: CATCHUP_TIMEOUT_MS,
}

let ws: WebSocket | null = null
let status: SocketStatus = 'idle'
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let lastMsgAt = 0
let docId: string | null = null
let peers: Peer[] = []
let lastPresence: PresenceOut | null = null
let chain: Promise<unknown> = Promise.resolve()
let generation = 0
let wired = false
let throttle = createPresenceThrottle(sendPresenceNow, 100)

const listeners = new Map<string, Set<Fn>>()
const statusSubs = new Set<() => void>()
const peerSubs = new Set<() => void>()

/** Subscribe to a server message type ('markup', 'attachments', 'scales', 'layers', 'symbol_sets', 'revision', 'error') or the synthetic 'resync'. */
export function on(type: string, fn: Fn): () => void {
  let set = listeners.get(type)
  if (!set) listeners.set(type, (set = new Set()))
  set.add(fn)
  return () => { set!.delete(fn) }
}
function emit(type: string, msg: any) {
  for (const fn of [...(listeners.get(type) ?? [])]) { try { fn(msg) } catch (e) { console.error(e) } }
}

export const getStatus = () => status
export const subscribeStatus = (fn: () => void) => { statusSubs.add(fn); return () => { statusSubs.delete(fn) } }
export const getPeers = () => peers
export const subscribePeers = (fn: () => void) => { peerSubs.add(fn); return () => { peerSubs.delete(fn) } }

function setStatus(s: SocketStatus) {
  if (s === status) return
  status = s
  for (const f of [...statusSubs]) f()
}
function setPeers(next: Peer[]) {
  if (next === peers) return
  peers = next
  for (const f of [...peerSubs]) f()
}

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false

function url(token: string) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(getClientId())}${companyQuery()}`
}

function companyQuery() {
  const id = getActiveCompanyId()
  return id ? `&company=${encodeURIComponent(id)}` : ''
}

/** Tell the server which company's live events this connection wants (after the user switches company). */
export function setSocketCompany(companyId: string | null) {
  if (companyId) rawSend({ type: 'company', companyId })
}

function rawSend(obj: unknown): boolean {
  if (!ws || ws.readyState !== 1) return false
  ws.send(JSON.stringify(obj))
  return true
}

function sendPresenceNow(p: PresenceOut) {
  rawSend({ type: 'presence', page: p.page, cursor: p.cursor, selection: p.selection, viewport: p.viewport ?? null, marquee: p.marquee ?? null })
}

/** Start (or restart after sign-in) the connection if a token exists. Safe to call any time. */
export function connect() {
  wire()
  if (ws) return
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  const token = getToken()
  if (!token) { setStatus('idle'); return }
  setStatus('reconnecting')
  if (!online()) return // the 'online' event reconnects
  let sock: WebSocket
  try { sock = new WebSocket(url(token)) } catch { scheduleReconnect(); return }
  ws = sock
  const myGen = ++generation
  sock.onopen = () => {
    if (ws !== sock) return
    attempt = 0
    lastMsgAt = Date.now()
    setStatus('live')
    throttle.reset()
    startPing()
    if (docId) enterDocument(docId, myGen)
  }
  sock.onmessage = ev => {
    if (ws !== sock) return
    lastMsgAt = Date.now()
    let msg: any
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (!msg || typeof msg.type !== 'string') return
    chain = chain.then(() => handle(msg)).catch(e => console.error('realtime handler failed', e))
  }
  sock.onclose = ev => {
    if (ws !== sock) return
    ws = null
    stopPing()
    setPeers(peers.length ? [] : peers)
    // 4401 after our own password change: the stored token was already replaced, so just reconnect with it
    if (ev.code === 4401 && getToken() === token) { setStatus('idle'); signalAuthExpired(); return }
    if (!getToken()) { setStatus('idle'); return }
    setStatus('reconnecting')
    scheduleReconnect()
  }
  sock.onerror = () => { /* onclose follows */ }
}

function scheduleReconnect(delay?: number) {
  if (reconnectTimer) return
  const ms = delay ?? reconnectDelay(attempt++)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, ms)
}

function startPing() {
  stopPing()
  pingTimer = setInterval(() => {
    if (Date.now() - lastMsgAt > STALE_MS) { try { ws?.close() } catch { /* ignore */ } return }
    rawSend({ type: 'ping' })
  }, PING_MS)
}
function stopPing() { if (pingTimer) clearInterval(pingTimer); pingTimer = null }

/** One catch-up attempt with a timeout (the request is aborted, and we stop waiting for it either way). */
async function runCatchUp(id: string): Promise<void> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new Error('catch-up timed out')) }, hooks.catchUpTimeoutMs)
  })
  try { await Promise.race([hooks.catchUp(id, ctl.signal), timeout]) } finally { clearTimeout(timer) }
}

function afterCatchUp(id: string, gen: number) {
  if (docId !== id || generation !== gen) return
  emit('resync', { type: 'resync', documentId: id })
  // Everything else the viewer shows is refetched by its owner on these synthetic events.
  emit('scales', { type: 'scales', by: '' })
  emit('layers', { type: 'layers', by: '' })
  emit('symbol_sets', { type: 'symbol_sets', by: '' })
  emit('revision', { type: 'revision', by: '' })
  emit('attachments', { type: 'attachments', markupId: '*', by: '' })
}

/** Retry a failed catch-up in the background (does not hold up messages), while we are still in that room. */
function retryCatchUp(id: string, gen: number, tries: number) {
  if (tries >= CATCHUP_RETRIES) return
  setTimeout(() => {
    if (docId !== id || generation !== gen || !ws || ws.readyState !== 1) return
    runCatchUp(id).then(() => afterCatchUp(id, gen)).catch(e => { console.warn('realtime catch-up failed', e); retryCatchUp(id, gen, tries + 1) })
  }, CATCHUP_RETRY_MS * (tries + 1))
}

/** Join the room and catch up on what was missed. */
function enterDocument(id: string, gen: number) {
  rawSend({ type: 'join', documentId: id })
  if (lastPresence) throttle.push(lastPresence)
  const catchUp = runCatchUp(id).then(() => afterCatchUp(id, gen)).catch(e => {
    console.warn('realtime catch-up failed', e)
    retryCatchUp(id, gen, 0)
  })
  chain = chain.then(() => catchUp)
}

async function handle(msg: any) {
  if (msg.type === 'pong') return
  if (msg.type === 'peers' || msg.type === 'peer' || msg.type === 'leave') {
    setPeers(reducePeers(peers, msg, getClientId()))
    return
  }
  if (msg.type === 'markup') {
    const applied = await applyServerMessage(msg, docId)
    emit('markup', { ...msg, applied })
    return
  }
  // Catalog events carry the company they are about; one for another company is not for this screen.
  if (msg.type === 'symbol_sets' && msg.companyId) {
    const active = getActiveCompanyId()
    if (active && msg.companyId !== active) return
  }
  emit(msg.type, msg)
}

/** Enter a document's room (null = leave it; the socket is recycled because the protocol has no leave message). */
export function joinDocument(id: string | null) {
  if (id === docId) return
  docId = id
  lastPresence = null
  throttle.cancel()
  throttle.reset()
  setPeers(peers.length ? [] : peers)
  if (id === null) {
    if (ws && ws.readyState === 1) {
      const s = ws
      ws = null; stopPing()
      try { s.close(1000) } catch { /* ignore */ }
      setStatus('reconnecting')
      connect()
    }
    return
  }
  if (ws && ws.readyState === 1) enterDocument(id, generation)
  else connect()
}

/** Throttled to ~10/s; ignored while not in a document. */
export function sendPresence(p: PresenceOut) {
  if (!docId) return
  lastPresence = p
  throttle.push(p)
}

/**
 * Close the connection and forget it (sign-out). The socket belongs to the user who opened it, so it must not
 * outlive them: the next user's `connect()` then opens a new one with their own token.
 */
export function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  const s = ws
  ws = null; stopPing(); generation++
  docId = null; lastPresence = null; throttle.cancel(); throttle.reset()
  try { s?.close(1000) } catch { /* ignore */ }
  setPeers(peers.length ? [] : peers)
  setStatus('idle')
}

function wire() {
  if (wired || typeof window === 'undefined') return
  wired = true
  window.addEventListener('online', () => { attempt = 0; if (!ws) connect() })
  window.addEventListener('planmark:signed-out', disconnect)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !ws) { attempt = 0; connect() }
  })
}

/** Test hooks. */
export function configureSocket(opts: Partial<Hooks>) {
  Object.assign(hooks, opts)
  if (opts.presenceIntervalMs) throttle = createPresenceThrottle(sendPresenceNow, opts.presenceIntervalMs)
}
export function resetSocketForTests() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  stopPing()
  ws = null; reconnectTimer = null; status = 'idle'; attempt = 0; docId = null; peers = []; lastPresence = null
  chain = Promise.resolve(); generation = 0; wired = false
  listeners.clear()
  throttle.cancel()
  throttle = createPresenceThrottle(sendPresenceNow, hooks.presenceIntervalMs)
}
