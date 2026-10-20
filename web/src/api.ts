import { getClientId } from './realtime/clientId'

export type Role = 'admin' | 'editor' | 'viewer'

export interface User { id: string; email: string; name: string; is_admin: boolean }
export interface Project { id: string; name: string; created_at: string; role: Role; document_count?: number }
export interface DocumentSummary {
  id: string; name: string; created_at: string
  revision_id: string; revision: number; page_count: number
}
export interface Member { id: string; email: string; name: string; role: Role }

const TOKEN_KEY = 'planmark.token'

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* storage unavailable */ }
}

/** The session is no longer valid (REST 401 or websocket 4401): forget the token and tell the app. */
export function signalAuthExpired() {
  setToken(null)
  window.dispatchEvent(new Event('planmark:signed-out'))
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  headers.set('X-Client-Id', getClientId())
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const res = await fetch(`/api${path}`, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && token) {
    signalAuthExpired()
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`)
  return data as T
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const documentFileUrl = (id: string, revisionId?: string) =>
  `/api/documents/${id}/file?token=${encodeURIComponent(getToken() ?? '')}` + (revisionId ? `&revision=${encodeURIComponent(revisionId)}` : '')

export interface DocumentRevision {
  id: string; revision: number; page_count: number; created_at: string
  uploaded_by?: string | null; uploaded_by_name?: string | null
  /** 'upload' (a new PDF or page edit) or 'issued' (a named snapshot of the same PDF) or 'restore' (an older revision made current again). */
  kind?: 'upload' | 'issued' | 'restore'
  label?: string; note?: string
  /** False only for the newest revision, whose markups are still the live ones. */
  has_snapshot?: boolean
}
/** Answer to uploading a new revision: markups on pages the new file doesn't have are kept and reported. */
export type RevisionUpload = DocumentRevision & { orphaned_markups: number; orphaned_pages: number[] }

export interface Attachment {
  id: string; markup_id: string; caption: string; width: number; height: number
  created_at: string; created_by: string; has_annotation: boolean
}
export const attachmentFileUrl = (id: string, variant?: 'original' | 'annotated', v?: string | number) =>
  `/api/attachments/${id}/file?token=${encodeURIComponent(getToken() ?? '')}` +
  (variant ? `&variant=${variant}` : '') + (v !== undefined ? `&v=${encodeURIComponent(String(v))}` : '')
