/** Durable-storage request and usage readout. Browsers may evict IndexedDB under pressure unless storage is persistent. */
import { useEffect, useState } from 'react'

export interface StorageState {
  /** null = unknown / unsupported */
  persisted: boolean | null
  usage: number | null
  quota: number | null
}

type StorageLike = Pick<StorageManager, 'persist' | 'persisted' | 'estimate'>

const manager = (): Partial<StorageLike> | undefined =>
  (typeof navigator !== 'undefined' ? (navigator as { storage?: Partial<StorageLike> }).storage : undefined)

let asked: Promise<boolean | null> | null = null
const listeners = new Set<() => void>()
export const subscribeStorage = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** Ask for persistent storage once per page load. Resolves with whether it is granted (null = unsupported). */
export function requestPersistence(): Promise<boolean | null> {
  if (asked) return asked
  asked = (async () => {
    const s = manager()
    if (!s?.persist) return null
    try {
      if (s.persisted && await s.persisted()) return true
      return await s.persist()
    } catch { return null }
  })().then(r => { for (const l of [...listeners]) l(); return r })
  return asked
}

export function resetPersistenceRequest() { asked = null }

export async function readStorageState(): Promise<StorageState> {
  const s = manager()
  let persisted: boolean | null = null, usage: number | null = null, quota: number | null = null
  try { if (s?.persisted) persisted = await s.persisted() } catch { /* unknown */ }
  try {
    if (s?.estimate) { const e = await s.estimate(); usage = e.usage ?? null; quota = e.quota ?? null }
  } catch { /* unknown */ }
  return { persisted, usage, quota }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** Warning text when the browser did not grant durable storage (null = fine or unknown). */
export const persistWarning = (st: StorageState) =>
  st.persisted === false ? 'This device may clear offline data when storage is low.' : null

export function useStorageState(active: boolean): StorageState {
  const [st, setSt] = useState<StorageState>({ persisted: null, usage: null, quota: null })
  useEffect(() => {
    if (!active) return
    let live = true
    const load = () => { void readStorageState().then(v => { if (live) setSt(v) }) }
    load()
    const unsub = subscribeStorage(load)
    return () => { live = false; unsub() }
  }, [active])
  return st
}
