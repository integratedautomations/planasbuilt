// The company this device is working in. Kept in localStorage so API calls (X-Company-Id), file URLs (?company=),
// the realtime socket and the offline cache all agree on it before /api/me has answered.
const KEY = 'planmark.activeCompany'

let current: string | null = null
let loaded = false
const subs = new Set<(id: string | null) => void>()

export function getActiveCompanyId(): string | null {
  if (!loaded) {
    loaded = true
    try { current = localStorage.getItem(KEY) } catch { current = null }
  }
  return current
}

/** Make `id` the active company (null forgets it: the server then uses the last company used). */
export function setActiveCompanyId(id: string | null) {
  loaded = true
  if (id === current) return
  current = id
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY) } catch { /* storage unavailable */ }
  for (const f of [...subs]) f(id)
}

export function subscribeActiveCompany(fn: (id: string | null) => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** Test hook: forget the in-memory copy so the next read goes to storage again. */
export function resetActiveCompanyForTests() { loaded = false; current = null; subs.clear() }
