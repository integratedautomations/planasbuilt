import { ApiError } from '../api'

/**
 * What to do with a failed request.
 *  - 'network': no connection / server unreachable / gateway error: keep the item, retry later
 *  - 'auth':    401: stop draining and ask the user to sign in
 *  - 'retry':   408/425/429/5xx: transient server trouble, keep and back off
 *  - 'permanent': any other 4xx: mark the item failed (visible), keep draining
 */
export type ErrorClass = 'network' | 'auth' | 'retry' | 'permanent'

export function classifyError(e: unknown): ErrorClass {
  if (!(e instanceof ApiError)) return 'network' // fetch() rejects with TypeError when offline
  const s = e.status
  if (s === 401) return 'auth'
  if (s === 502 || s === 503 || s === 504 || s === 0) return 'network' // dev proxy / gateway with server down
  if (s === 423) return 'permanent' // company archived: it will not come back by retrying
  if (s === 408 || s === 425 || s === 429 || s >= 500) return 'retry'
  if (s >= 400) return 'permanent'
  return 'retry'
}

/** True when a read failed because we're offline (as opposed to the server rejecting it). */
export const isOfflineError = (e: unknown) => classifyError(e) === 'network'

/** Thrown by cache loaders when offline and nothing is stored locally. */
export class OfflineMissError extends Error {
  constructor(what = 'This') { super(`${what} isn't available offline. Open it once while online, or use "Make available offline".`) }
}
