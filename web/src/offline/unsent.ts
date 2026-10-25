/** Age thresholds and wording for unsent work. */
export const STALE_MS = 24 * 3600 * 1000

export const isStale = (oldestAt: number | null, now: number) => oldestAt !== null && now - oldestAt > STALE_MS

export function agoText(at: number | null, now: number): string {
  if (at === null) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export const unsentLabel = (n: number) => `${n} unsent`

export function staleMessage(count: number, oldestAt: number): string {
  const d = new Date(oldestAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  return `You have ${count} change${count === 1 ? '' : 's'} waiting since ${d}. Connect to the internet to send them.`
}

const KEY = 'planmark.lastSync'
export function loadLastSync(): number | null {
  try { const n = Number(localStorage.getItem(KEY)); return n > 0 ? n : null } catch { return null }
}
export function saveLastSync(t: number) { try { localStorage.setItem(KEY, String(t)) } catch { /* ignore */ } }
