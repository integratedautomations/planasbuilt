import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'

const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d']
export const colorFor = (userId: string) => PALETTE[createHash('sha1').update(userId).digest().readUInt32BE(0) % PALETTE.length]

export interface Peer {
  clientId: string
  userId: string
  name: string
  /** Avatar version (changes whenever the picture does); null = no picture. */
  avatar: number | null
  color: string
  page: number | null
  cursor: { x: number; y: number } | null
  selection: string[]
  /** Visible area in page coordinates. */
  viewport: { x: number; y: number; w: number; h: number } | null
  /** Box-select drag in progress. */
  marquee: { x: number; y: number; w: number; h: number } | null
}

export interface Conn extends Peer {
  socket: WebSocket
  documentId: string | null
  alive: boolean
  /** Set by remove(): a socket that is gone must never be put back into a room. */
  removed?: boolean
  windowStart: number
  windowCount: number
  joinWindowStart: number
  joinCount: number
}

const MAX_PRESENCE_PER_SEC = 15
/** Joins cost a database lookup each, so they are limited per socket. */
const JOIN_WINDOW_MS = 10_000, MAX_JOINS_PER_WINDOW = 20

/** Rooms of websocket connections keyed by document id, plus broadcast helpers. */
export class Realtime {
  private conns = new Set<Conn>()
  private rooms = new Map<string, Set<Conn>>()
  private timer: NodeJS.Timeout

  constructor(heartbeatMs = 30_000) {
    this.timer = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) { c.socket.terminate(); continue }
        c.alive = false
        try { c.socket.ping() } catch { /* socket is going away */ }
      }
    }, heartbeatMs)
    this.timer.unref()
  }

  close() { clearInterval(this.timer) }

  add(socket: WebSocket, info: { clientId: string; userId: string; name: string; avatar?: number | null }): Conn {
    const c: Conn = {
      socket, ...info, avatar: info.avatar ?? null, color: colorFor(info.userId), page: null, cursor: null, selection: [], viewport: null, marquee: null,
      documentId: null, alive: true, windowStart: 0, windowCount: 0, joinWindowStart: 0, joinCount: 0,
    }
    this.conns.add(c)
    socket.on('pong', () => { c.alive = true })
    return c
  }

  /** Open sockets of a user (across all their devices and tabs). */
  countFor(userId: string) {
    let n = 0
    for (const c of this.conns) if (c.userId === userId) n++
    return n
  }

  /** False when this socket is joining rooms too fast (a fixed window per socket). */
  allowJoin(c: Conn) {
    const now = Date.now()
    if (now - c.joinWindowStart >= JOIN_WINDOW_MS) { c.joinWindowStart = now; c.joinCount = 0 }
    return ++c.joinCount <= MAX_JOINS_PER_WINDOW
  }

  remove(c: Conn) {
    c.removed = true
    this.leave(c)
    this.conns.delete(c)
  }

  /** Closes every socket of a user (deactivated, password changed, role changed). */
  kickUser(userId: string) {
    for (const c of [...this.conns]) if (c.userId === userId) { try { c.socket.close(4401, 'Signed out') } catch { /* going away */ } this.remove(c) }
  }

  /** Takes a user out of the given documents' rooms (removed from a project). */
  dropUserFromDocs(userId: string, documentIds: string[]) {
    const ids = new Set(documentIds)
    for (const c of [...this.conns]) if (c.userId === userId && c.documentId && ids.has(c.documentId)) this.leave(c)
  }

  private send(c: Conn, msg: unknown) {
    if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg))
  }

  private static peerOf(c: Conn): Peer {
    return { clientId: c.clientId, userId: c.userId, name: c.name, avatar: c.avatar, color: c.color, page: c.page, cursor: c.cursor, selection: c.selection, viewport: c.viewport, marquee: c.marquee }
  }

  private toRoom(documentId: string, msg: unknown, except?: string | null, exceptConn?: Conn) {
    for (const c of this.rooms.get(documentId) ?? []) {
      if (c === exceptConn || (except && c.clientId === except)) continue
      this.send(c, msg)
    }
  }

  error(c: Conn, message: string) { this.send(c, { type: 'error', message }) }
  pong(c: Conn) { this.send(c, { type: 'pong' }) }

  join(c: Conn, documentId: string) {
    if (c.removed || c.documentId === documentId) return
    this.leave(c)
    c.documentId = documentId
    c.page = null; c.cursor = null; c.selection = []; c.viewport = null; c.marquee = null
    let room = this.rooms.get(documentId)
    if (!room) this.rooms.set(documentId, (room = new Set()))
    room.add(c)
    this.send(c, { type: 'peers', peers: [...room].filter(p => p !== c && p.clientId !== c.clientId).map(Realtime.peerOf) })
    this.toRoom(documentId, { type: 'peer', peer: Realtime.peerOf(c) }, null, c)
  }

  leave(c: Conn) {
    const id = c.documentId
    if (!id) return
    c.documentId = null
    const room = this.rooms.get(id)
    room?.delete(c)
    if (room && !room.size) this.rooms.delete(id)
    // A reconnect can join before the old socket's close arrives: the peer (same clientId) is still here, so no leave.
    if (room && [...room].some(o => o.clientId === c.clientId)) return
    this.toRoom(id, { type: 'leave', clientId: c.clientId })
  }

  presence(c: Conn, m: any) {
    if (!c.documentId) return
    const now = Date.now()
    if (now - c.windowStart >= 1000) { c.windowStart = now; c.windowCount = 0 }
    if (++c.windowCount > MAX_PRESENCE_PER_SEC) return
    c.page = Number.isInteger(m.page) ? m.page : null
    const cur = m.cursor
    c.cursor = cur && Number.isFinite(cur.x) && Number.isFinite(cur.y) ? { x: cur.x, y: cur.y } : null
    c.selection = Array.isArray(m.selection) ? m.selection.filter((s: unknown) => typeof s === 'string').slice(0, 500) : []
    const v = m.viewport
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6
    c.viewport = v && ok(v.x) && ok(v.y) && ok(v.w) && ok(v.h) && v.w > 0 && v.h > 0 ? { x: v.x, y: v.y, w: v.w, h: v.h } : null
    const q = m.marquee
    c.marquee = q && ok(q.x) && ok(q.y) && ok(q.w) && ok(q.h) && q.w >= 0 && q.h >= 0 ? { x: q.x, y: q.y, w: q.w, h: q.h } : null
    this.toRoom(c.documentId, { type: 'peer', peer: Realtime.peerOf(c) }, null, c)
  }

  // ---- Broadcast helpers used by REST handlers (clientId = originating socket to skip) ----
  markupChanged(documentId: string, markup: unknown, by: string, clientId?: string | null) {
    this.toRoom(documentId, { type: 'markup', op: 'upsert', markup, by }, clientId)
  }
  markupDeleted(documentId: string, id: string, by: string, clientId?: string | null) {
    this.toRoom(documentId, { type: 'markup', op: 'delete', id, by }, clientId)
  }
  attachmentsChanged(documentId: string, markupId: string, by: string, clientId?: string | null) {
    this.toRoom(documentId, { type: 'attachments', markupId, by }, clientId)
  }
  scalesChanged(documentId: string, by: string, clientId?: string | null) {
    this.toRoom(documentId, { type: 'scales', by }, clientId)
  }
  /** The plan's device size multiplier changed. */
  deviceScaleChanged(documentId: string, deviceScale: number, by: string, clientId?: string | null) {
    this.toRoom(documentId, { type: 'device_scale', deviceScale, by }, clientId)
  }
  revisionChanged(documentId: string, revisionId: string, revision: number, by: string, clientId?: string | null) {
    this.toRoom(documentId, { type: 'revision', revisionId, revision, by }, clientId)
  }
  /** The document's markups were replaced wholesale (a revision was restored): clients reload them. */
  markupsReset(documentId: string, by: string, clientId?: string | null) {
    this.toRoom(documentId, { type: 'markups_reset', by }, clientId)
  }
  layersChanged(documentIds: string[], by: string, clientId?: string | null) {
    for (const id of documentIds) this.toRoom(id, { type: 'layers', by }, clientId)
  }
  symbolSetsChanged(by: string, clientId?: string | null) {
    for (const c of this.conns) if (!(clientId && c.clientId === clientId)) this.send(c, { type: 'symbol_sets', by })
  }
}
