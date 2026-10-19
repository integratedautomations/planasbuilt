import type { User } from '../api'

const KEY = 'planmark.user'
/** Last signed-in user, so the app can open offline when /me can't be reached. */
export function cacheUser(u: User | null) {
  try { if (u) localStorage.setItem(KEY, JSON.stringify(u)); else localStorage.removeItem(KEY) } catch { /* ignore */ }
}
export function cachedUser(): User | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) as User : null } catch { return null }
}
