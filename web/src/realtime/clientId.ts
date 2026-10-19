import { uuid } from '../uuid'

const KEY = 'planmark.clientId'
let memo: string | null = null

/** Per-tab id (sessionStorage), sent as X-Client-Id and as ?clientId= so the server doesn't echo our own changes back. */
export function getClientId(): string {
  if (memo) return memo
  try {
    const s = sessionStorage.getItem(KEY)
    if (s) return (memo = s)
    memo = uuid()
    sessionStorage.setItem(KEY, memo)
  } catch { memo ??= uuid() }
  return memo
}
