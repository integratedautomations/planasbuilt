/** Pure presence helpers: the peer list reducer and the outgoing throttle. */

export interface Peer {
  clientId: string
  userId: string
  name: string
  /** Avatar version, null when the person has no picture. */
  avatar?: number | null
  /** Chosen initials background (#rrggbb), if any. */
  avatarColor?: string | null
  color: string
  page: number | null
  cursor: { x: number; y: number } | null
  selection: string[]
  /** Visible area in page coordinates (null/absent = unknown). */
  viewport?: Rect | null
  /** Box-select drag in progress (page coordinates); null once released. */
  marquee?: Rect | null
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface PresenceOut {
  page: number | null
  cursor: { x: number; y: number } | null
  selection: string[]
  viewport?: Rect | null
  marquee?: Rect | null
}

/** The page-space rectangle visible in a viewport of the given pixel size, for a stage transform. */
export function viewportRect(view: { x: number; y: number; zoom: number }, box: { width: number; height: number }): Rect | null {
  if (!(view.zoom > 0) || !(box.width > 0) || !(box.height > 0)) return null
  const r = (n: number) => Math.round(n * 10) / 10
  return { x: r(-view.x / view.zoom), y: r(-view.y / view.zoom), w: r(box.width / view.zoom), h: r(box.height / view.zoom) }
}

/** The stage transform that shows the rectangle (centred, with a little margin) in a viewport of the given size. */
export function viewForRect(rect: Rect, box: { width: number; height: number }, margin = 16): { x: number; y: number; zoom: number } | null {
  if (!(rect.w > 0) || !(rect.h > 0) || !(box.width > 0) || !(box.height > 0)) return null
  const zoom = Math.min((box.width - margin * 2) / rect.w, (box.height - margin * 2) / rect.h)
  if (!(zoom > 0)) return null
  return { zoom, x: box.width / 2 - (rect.x + rect.w / 2) * zoom, y: box.height / 2 - (rect.y + rect.h / 2) * zoom }
}

/** Apply a server message to the peer list (immutable; returns the same array when nothing changed). */
export function reducePeers(peers: Peer[], msg: any, selfClientId: string): Peer[] {
  switch (msg?.type) {
    case 'peers':
      return Array.isArray(msg.peers) ? msg.peers.filter((p: Peer) => p.clientId !== selfClientId) : peers
    case 'peer': {
      const p = msg.peer as Peer | undefined
      if (!p || p.clientId === selfClientId) return peers
      const i = peers.findIndex(x => x.clientId === p.clientId)
      if (i < 0) return [...peers, p]
      const next = peers.slice()
      next[i] = p
      return next
    }
    case 'leave':
      return peers.some(p => p.clientId === msg.clientId) ? peers.filter(p => p.clientId !== msg.clientId) : peers
    default:
      return peers
  }
}

const samePresence = (a: PresenceOut, b: PresenceOut) =>
  a.page === b.page && a.cursor?.x === b.cursor?.x && a.cursor?.y === b.cursor?.y &&
  a.selection.length === b.selection.length && a.selection.every((s, i) => s === b.selection[i]) &&
  a.viewport?.x === b.viewport?.x && a.viewport?.y === b.viewport?.y && a.viewport?.w === b.viewport?.w && a.viewport?.h === b.viewport?.h &&
  a.marquee?.x === b.marquee?.x && a.marquee?.y === b.marquee?.y && a.marquee?.w === b.marquee?.w && a.marquee?.h === b.marquee?.h

/**
 * Leading + trailing throttle for presence updates: the first update goes out at once, later ones inside
 * the interval collapse to the newest and go out when the interval ends. Identical updates are dropped.
 */
export function createPresenceThrottle(send: (p: PresenceOut) => void, intervalMs = 100) {
  let last = 0
  let sent: PresenceOut | null = null
  let queued: PresenceOut | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    if (!queued) return
    const p = queued
    queued = null
    if (sent && samePresence(sent, p)) return
    last = Date.now(); sent = p
    send(p)
  }
  return {
    push(p: PresenceOut) {
      queued = p
      const wait = last + intervalMs - Date.now()
      if (wait <= 0) { if (timer) { clearTimeout(timer); timer = null } flush() }
      else if (!timer) timer = setTimeout(flush, wait)
    },
    /** Forget what was sent (after a reconnect the server has lost our state). */
    reset() { sent = null },
    cancel() { if (timer) clearTimeout(timer); timer = null; queued = null },
  }
}

/** Initials for an avatar: first letters of the first two words. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[1][0] : '')).toUpperCase()
}

/** Black or white, whichever reads better on the given #rrggbb background (WCAG relative luminance). */
export function contrastText(bg: string): '#000' | '#fff' {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg)
  if (!m) return '#fff'
  const lin = (i: number) => { const c = parseInt(m[1].slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4)
  return L > 0.179 ? '#000' : '#fff'
}

/** One entry per person (a user with two tabs shows once); the first `max` are shown, the rest counted. */
export function avatarStack(peers: Peer[], max = 4) {
  const seen = new Set<string>()
  const people: Peer[] = []
  for (const p of peers) if (!seen.has(p.userId)) { seen.add(p.userId); people.push(p) }
  return { shown: people.slice(0, max), more: Math.max(0, people.length - max) }
}

const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d']
/** A stable colour for a user id (used where no server-assigned colour is at hand). */
export function userColor(userId: string): string {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}
