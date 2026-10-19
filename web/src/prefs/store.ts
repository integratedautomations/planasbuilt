// Client prefs store: cached in localStorage per user, saved to the server (debounced), works offline.
import { useSyncExternalStore } from 'react'
import { api } from '../api'
import { effectivePrefs, EMPTY_STORED, mergePrefs, sanitizeStored } from './prefs'
import type { PrefKey, Prefs, StoredPrefs } from './prefs'

const KEY = 'planmark.prefs'
const SAVE_DELAY = 800

let userId: string | null = null
let stored: StoredPrefs = EMPTY_STORED
/** Local changes the server has not confirmed yet (kept in storage so a reload while offline still saves later). */
let dirty = false
let snapshot: Prefs = effectivePrefs(stored)
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

const storageKey = () => `${KEY}.${userId ?? 'anon'}`

function readLocal(): { stored: StoredPrefs; dirty: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey()) ?? 'null')
    return { stored: sanitizeStored(raw), dirty: !!raw?.dirty }
  } catch { return { stored: EMPTY_STORED, dirty: false } }
}

function writeLocal() {
  try { localStorage.setItem(storageKey(), JSON.stringify({ ...stored, dirty })) } catch { /* storage unavailable */ }
}

function publish() {
  snapshot = effectivePrefs(stored)
  listeners.forEach(l => l())
}

/** Switch to a user's prefs (or none on sign-out): loads their cached copy, then merges the server's. */
export function setPrefsUser(id: string | null) {
  if (id === userId) return
  clearTimeout(timer)
  userId = id
  ;({ stored, dirty } = id ? readLocal() : { stored: EMPTY_STORED, dirty: false })
  publish()
  if (id) void syncPrefs()
}

async function push() {
  if (!userId || !dirty) return
  const sending = stored
  try {
    await api('/me/prefs', { method: 'PUT', body: JSON.stringify({ prefs: sending }) })
    if (stored === sending) { dirty = false; writeLocal() } // no newer edit arrived meanwhile
    else schedulePush()
  } catch { /* offline or server down: stays dirty, retried on reconnect / next start */ }
}

function schedulePush() {
  clearTimeout(timer)
  timer = setTimeout(() => { void push() }, SAVE_DELAY)
}

/** Pull the server copy, merge per setting, and push back whatever is newer here. */
export async function syncPrefs() {
  if (!userId) return
  const forUser = userId
  try {
    const res = await api<{ prefs: unknown }>('/me/prefs')
    if (forUser !== userId) return
    const { merged, pushNeeded, changed } = mergePrefs(stored, sanitizeStored(res.prefs))
    if (changed) { stored = merged; writeLocal(); publish() }
    if (pushNeeded || dirty) { dirty = true; writeLocal(); schedulePush() }
  } catch { /* offline: use the cached copy; syncs when back online */ }
}

/** Change one setting. Applied and cached at once; saved to the server shortly after. */
export function setPref<K extends PrefKey>(key: K, value: Prefs[K]) {
  stored = { data: { ...stored.data, [key]: value }, stamps: { ...stored.stamps, [key]: Date.now() } }
  dirty = true
  writeLocal()
  publish()
  schedulePush()
}

export const getPrefs = () => snapshot

export function usePrefs(): Prefs {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, getPrefs)
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { void syncPrefs() })
  window.addEventListener('beforeunload', () => { if (dirty && userId) { clearTimeout(timer); void push() } })
}
