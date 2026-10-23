import { getClientId } from './realtime/clientId'
import { getActiveCompanyId } from './company/activeCompany'

import type { CompanyRole, Role, Scope } from './roles'
import type { ProjectSettings as ProjectSettingsData } from './projectSettings'
export type { Role, Scope }

/** The company a user is working in (null: no company yet). */
export interface ActiveCompany { id: string; name: string; role: CompanyRole | null; archived: boolean }
export interface User { id: string; email: string; name: string; /** Admin of the active company, or a platform admin. */ is_admin: boolean; /** Can create and see every company. */ platform_admin?: boolean; company?: ActiveCompany | null; /** Admins always can; other people only when an admin granted it. */ can_create_projects?: boolean; avatar?: number | null }
export interface Project { id: string; name: string; company_id?: string; /** False when an owner or admin sees a project they are not a member of. */ is_member?: boolean; created_at: string; role: Role; document_count?: number; status?: 'open' | 'completed'; completed_at?: string | null
  /** Sub only: the symbol sets and layers they work on. */
  scope?: Scope
  /** Whether this person sees unit costs and labor hours in the project. */
  can_see_costs?: boolean
  /** Project setting: editors see costs (pm and admin always do). Default on. */
  editors_see_costs?: boolean
  /** Cable defaults: slack added to every drawn run (percent) and the drop length added at each linked end (feet). */
  cable_slack_pct?: number
  cable_drop_ft?: number
  /** Project settings (status workflow, required fields, tag rules, lock...); see projectSettings.ts. */
  settings?: ProjectSettingsData }
export interface DocumentSummary {
  id: string; name: string; created_at: string; device_scale?: number
  revision_id: string; revision: number; page_count: number
}
export interface Member { id: string; email: string; name: string; role: Role; /** Only sent to people who manage members. */ scope?: Scope }

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
  /** The parsed JSON error body, when there was one (e.g. a 409 conflict carries the server's current row). */
  body?: any
  constructor(status: number, message: string, body?: any) { super(message); this.status = status; this.body = body }
}

/** Every API call names the company it is for (unless the caller already did). */
export function setCompanyHeader(headers: Headers) {
  const company = getActiveCompanyId()
  if (company && !headers.has('X-Company-Id')) headers.set('X-Company-Id', company)
}

/** `?company=<id>` for file URLs that cannot carry headers; `sep` is '?' or '&' depending on the URL. */
export function companyParam(sep: '?' | '&' = '&'): string {
  const company = getActiveCompanyId()
  return company ? `${sep}company=${encodeURIComponent(company)}` : ''
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  headers.set('X-Client-Id', getClientId())
  if (token) headers.set('Authorization', `Bearer ${token}`)
  setCompanyHeader(headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const res = await fetch(`/api${path}`, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && token) {
    signalAuthExpired()
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data)
  return data as T
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })

/**
 * File URLs carry no credentials. Fetch them with `authFetch` / `fetchBlob` (Authorization header);
 * never put the login token in a URL (it ends up in logs, history and Referer headers).
 */
export const documentFileUrl = (id: string, revisionId?: string) =>
  `/api/documents/${id}/file` + (revisionId ? `?revision=${encodeURIComponent(revisionId)}` : '')

/** fetch() with the session's Authorization header (for file downloads). Does not turn 401 into a sign-out. */
export function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getToken()
  headers.set('X-Client-Id', getClientId())
  if (token) headers.set('Authorization', `Bearer ${token}`)
  setCompanyHeader(headers)
  return fetch(url, { ...init, headers })
}

/** Downloads a file URL to a Blob; throws ApiError on a non-2xx answer. */
export async function fetchBlob(url: string, init: RequestInit = {}): Promise<Blob> {
  const res = await authFetch(url, init)
  if (!res.ok) throw new ApiError(res.status, `Could not download the file (${res.status})`)
  return res.blob()
}

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
  `/api/attachments/${id}/file?` + [variant ? `variant=${variant}` : '', v !== undefined ? `v=${encodeURIComponent(String(v))}` : ''].filter(Boolean).join('&')

// ---- Settings, users and invites ----
export interface CompanyInfo {
  name: string; address: string; phone: string; prepared_by: string
  has_logo: boolean; logo_type: string
  tag_padding: 2 | 3 | 4; photo_max_dimension: number; email_enabled: boolean
}
export const companyLogoUrl = (v?: string | number) =>
  `/api/company/logo` + (v !== undefined ? `?v=${encodeURIComponent(String(v))}${companyParam('&')}` : companyParam('?'))

export type UserStatus = 'active' | 'invited' | 'deactivated'
export interface ManagedUser {
  id: string; email: string; name: string; is_admin: boolean; company_role?: CompanyRole | null; platform_admin?: boolean; can_create_projects: boolean; status: UserStatus
  last_seen_at: string | null; created_at: string; project_count: number; invite_expires_at: string | null
  projects?: { id: string; name: string; role: Role }[]
}
/** A freshly made invite or reset link. `emailed` says the server also sent it by email. */
export interface LinkResult { user_id: string; email: string; link: string | null; expires_at: string | null; emailed: boolean; email_error?: string
  /** The email already had an account: they were added to this company (or project) and there is no link to send. */
  added_to_company?: boolean }
