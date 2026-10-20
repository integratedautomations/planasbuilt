import { api, documentFileUrl, post } from '../api'
import type { DocumentRevision } from '../api'
import type { Markup } from '../markups/types'

export interface RevisionDetail extends DocumentRevision {
  /** True for the newest revision: its markups are the document's current ones. */
  live: boolean
  markups: Markup[]
  attachments: { id: string; markup_id: string; caption: string }[]
  scales: { page: number; points_per_foot: number; label: string }[]
}

/** "Rev 2 - As-built" or just "Rev 2". */
export const revisionName = (r: Pick<DocumentRevision, 'revision' | 'label'>) =>
  r.label ? `Rev ${r.revision} · ${r.label}` : `Rev ${r.revision}`

export const listRevisions = (documentId: string) => api<DocumentRevision[]>(`/documents/${documentId}/revisions`)
export const loadRevision = (documentId: string, revisionId: string) => api<RevisionDetail>(`/documents/${documentId}/revisions/${revisionId}`)
export const issueRevision = (documentId: string, label: string, note: string) =>
  post<DocumentRevision>(`/documents/${documentId}/revisions/issue`, { label, note })

/** Makes an older revision current again; newer ones are kept. The markups and scales of that revision are restored. */
export const makeRevisionCurrent = (documentId: string, revisionId: string) =>
  post<DocumentRevision & { restored_from: number; removed_markups: number; restored_markups: number }>(`/documents/${documentId}/revisions/${revisionId}/make-current`, {})

/** The bytes of one revision's PDF (not cached: the offline cache holds only the current one). */
export async function fetchRevisionPdf(documentId: string, revisionId: string): Promise<ArrayBuffer> {
  const res = await fetch(documentFileUrl(documentId, revisionId))
  if (!res.ok) throw new Error(`Could not download that revision (${res.status})`)
  return res.arrayBuffer()
}

export interface PageOpResult extends DocumentRevision { mapping: (number | null)[]; deleted_markups: number }

export const deletePages = (documentId: string, pages: number[]) => post<PageOpResult>(`/documents/${documentId}/pages/delete`, { pages })
export const reorderPages = (documentId: string, order: number[]) => post<PageOpResult>(`/documents/${documentId}/pages/reorder`, { order })
export const rotatePages = (documentId: string, pages: number[], degrees = 90) => post<PageOpResult>(`/documents/${documentId}/pages/rotate`, { pages, degrees })

/** Text fields go before the file: the server reads them as the stream arrives. */
export function insertPages(documentId: string, file: File, at: number) {
  const form = new FormData()
  form.append('at', String(at))
  form.append('file', file)
  return api<PageOpResult>(`/documents/${documentId}/pages/insert`, { method: 'POST', body: form })
}
export function replacePages(documentId: string, file: File, pages: string) {
  const form = new FormData()
  form.append('pages', pages)
  form.append('file', file)
  return api<PageOpResult>(`/documents/${documentId}/pages/replace`, { method: 'POST', body: form })
}

/** New order after moving page `from` so it sits at position `to` (both 1-based). order[i] = old page at new position i+1. */
export function moveOrder(count: number, from: number, to: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i + 1)
  order.splice(from - 1, 1)
  order.splice(to - 1, 0, from)
  return order
}
