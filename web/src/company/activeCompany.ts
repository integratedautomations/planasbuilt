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

/**
 * Whether a loaded project may move the app to its company. Not when the active company changed while the request was in
 * flight (the user switched company meanwhile: that choice wins over an answer from the page being left).
 */
export function shouldAdoptOwner(startedIn: string | null, nowActive: string | null, owner: string | null | undefined, gen?: number): boolean {
  if (gen !== undefined && gen !== switchGen) return false
  return !!owner && owner !== nowActive && startedIn === nowActive && switchHold === 0
}

// A deliberate switch from the company switcher is in progress (or just finished): pages being left must not pull the app back.
let switchHold = 0
let switchGen = 0
export const getSwitchGen = () => switchGen
export function beginSwitch() { switchHold++; switchGen++ }
export function endSwitch() { switchHold = Math.max(0, switchHold - 1); switchGen++ }

export function subscribeActiveCompany(fn: (id: string | null) => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** Test hook: forget the in-memory copy so the next read goes to storage again. */
export function resetActiveCompanyForTests() { loaded = false; current = null; subs.clear(); switchHold = 0; switchGen = 0 }
