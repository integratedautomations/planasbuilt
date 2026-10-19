import { useSyncExternalStore } from 'react'
import { getSnapshot, subscribeSnapshot } from './sync'
import type { SyncSnapshot } from './sync'

/** Live outbox/connection status (online, pending, failed, syncing). */
export function useSyncStatus(): SyncSnapshot {
  return useSyncExternalStore(subscribeSnapshot, getSnapshot, getSnapshot)
}
