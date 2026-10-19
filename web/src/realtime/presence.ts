/** Pure presence helpers: the peer list reducer and the outgoing throttle. */

export interface Peer {
  clientId: string
  userId: string
  name: string
  color: string
  page: number | null
  cursor: { x: number; y: number } | null
  selection: string[]
}

export interface PresenceOut {
  page: number | null
  cursor: { x: number; y: number } | null
  selection: string[]
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
  a.selection.length === b.selection.length && a.selection.every((s, i) => s === b.selection[i])

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

/** One entry per person (a user with two tabs shows once); the first `max` are shown, the rest counted. */
export function avatarStack(peers: Peer[], max = 4) {
  const seen = new Set<string>()
  const people: Peer[] = []
  for (const p of peers) if (!seen.has(p.userId)) { seen.add(p.userId); people.push(p) }
  return { shown: people.slice(0, max), more: Math.max(0, people.length - max) }
}
