import { uuid } from '../uuid'

let memo: string | null = null

/**
 * Per-page-load id, sent as X-Client-Id and as ?clientId= so the server doesn't echo our own changes back.
 * Kept in memory only: sessionStorage is copied by "Duplicate tab", which would give two live tabs the same id
 * (each would then miss the other's changes and the server could not tell their sockets apart).
 */
export function getClientId(): string {
  return (memo ??= uuid())
}
