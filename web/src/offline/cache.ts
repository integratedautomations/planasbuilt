/**
 * Read-through cache: try the network, store the answer in Dexie; if the network is down,
 * answer from Dexie. A server rejection (4xx) is NOT masked by the cache.
 * Throws OfflineMissError when offline and nothing is stored.
 *
 * Writes never go through here; see sync.ts.
 */
import { api, ApiError, documentFileUrl, attachmentFileUrl } from '../api'
import type { Attachment, DocumentSummary, Project } from '../api'
import type { Layer, Markup, SymbolSet } from '../markups/types'
import type { CatalogData } from '../catalog/types'
import { isOfflineError, OfflineMissError } from './classify'
import { db } from './db'
import type { AttachmentRow, PhotoVariant, ScaleRow } from './db'
import { mergeServerMarkups } from './sync'

/** revisions are newest first. */
export interface DocMeta { id: string; name: string; revisions: { id?: string; revision: number; page_count: number; kind?: 'upload' | 'issued'; label?: string }[] }
export interface ServerScale { page: number; points_per_foot: number; label: string; updated_at?: string }

export interface Loaded<T> { data: T; fromCache: boolean }

async function readThrough<T>(
  fetcher: () => Promise<T>,
  store: (data: T) => Promise<unknown>,
  local: () => Promise<T | undefined>,
  what: string,
): Promise<Loaded<T>> {
  try {
    const data = await fetcher()
    try { await store(data) } catch (e) { console.warn('offline cache write failed', e) }
    return { data, fromCache: false }
  } catch (e) {
    if (!isOfflineError(e)) throw e
    const data = await local()
    if (data === undefined) throw new OfflineMissError(what)
    return { data, fromCache: true }
  }
}

const nonEmpty = <T>(rows: T[]) => (rows.length ? rows : undefined)

export const loadProjects = () => readThrough(
  () => api<Project[]>('/projects'),
  async rows => db.transaction('rw', db.projects, async () => { await db.projects.clear(); await db.projects.bulkPut(rows) }),
  async () => (await db.projects.toArray()),
  'Your project list',
)

export const loadProject = (id: string) => readThrough(
  () => api<Project>(`/projects/${id}`),
  p => db.projects.put(p),
  () => db.projects.get(id),
  'This project',
)

export const loadDocuments = (projectId: string) => readThrough(
  () => api<DocumentSummary[]>(`/projects/${projectId}/documents`),
  async rows => db.transaction('rw', db.documents, async () => {
    await db.documents.where('project_id').equals(projectId).delete()
    await db.documents.bulkPut(rows.map(r => ({ ...r, project_id: projectId })))
  }),
  async () => {
    const rows = await db.documents.where('project_id').equals(projectId).toArray()
    return rows.length ? (rows as DocumentSummary[]) : undefined
  },
  'This project\'s plans',
)

export const loadDocMeta = (docId: string) => readThrough(
  () => api<DocMeta>(`/documents/${docId}`),
  m => db.kv.put({ key: `docmeta:${docId}`, value: m }),
  async () => (await db.kv.get(`docmeta:${docId}`))?.value as DocMeta | undefined,
  'This plan',
)

export const loadLayers = (projectId: string) => readThrough(
  () => api<Layer[]>(`/projects/${projectId}/layers`),
  async rows => db.transaction('rw', db.layers, async () => {
    await db.layers.where('project_id').equals(projectId).delete()
    await db.layers.bulkPut(rows)
  }),
  async () => (await db.layers.where('project_id').equals(projectId).toArray()),
  'Layers',
)

export const loadSymbolSets = () => readThrough(
  () => api<SymbolSet[]>('/symbol-sets'),
  async rows => db.transaction('rw', db.symbolSets, async () => { await db.symbolSets.clear(); await db.symbolSets.bulkPut(rows) }),
  async () => nonEmpty(await db.symbolSets.toArray()),
  'Symbol sets',
)

export const loadCatalog = () => readThrough(
  () => api<CatalogData>('/catalog'),
  async d => db.transaction('rw', db.deviceTypes, db.products, async () => {
    await db.deviceTypes.clear(); await db.deviceTypes.bulkPut(d.device_types)
    await db.products.clear(); await db.products.bulkPut(d.products)
  }),
  async () => {
    const device_types = await db.deviceTypes.toArray(), products = await db.products.toArray()
    return device_types.length || products.length ? { device_types, products } : undefined
  },
  'Catalog',
)

/** Scales for a document, always read back from Dexie so queued (unsent) scale edits are respected. */
export const loadScales = (docId: string) => loadScalesRaw(docId)
  .then(async r => ({ data: await localScales(docId), fromCache: r.fromCache }))

const loadScalesRaw = (docId: string) => readThrough(
  () => api<ServerScale[]>(`/documents/${docId}/scales`),
  async rows => db.transaction('rw', db.scales, db.outbox, async () => {
    // keep scales with unsent edits; replace the rest
    const queued = await db.outbox.where('docId').equals(docId).filter(i => i.kind.startsWith('scale_')).count()
    if (queued) return
    await db.scales.where('document_id').equals(docId).delete()
    await db.scales.bulkPut(rows.map<ScaleRow>(r => ({ ...r, key: `${docId}:${r.page}`, document_id: docId })))
  }),
  async () => (await db.scales.where('document_id').equals(docId).toArray()),
  'Scales',
)

/** Local scales with queued edits already applied (used instead of the server list while edits are unsent). */
export const localScales = (docId: string) => db.scales.where('document_id').equals(docId).toArray()

export const loadMarkups = (docId: string) => readThrough(
  () => api<Markup[]>(`/documents/${docId}/markups`),
  async () => {}, // merged below so unsent local edits survive
  async () => undefined,
  'Markups',
).then(async r => ({ data: await mergeServerMarkups(docId, r.data), fromCache: r.fromCache }))
  .catch(async e => {
    if (!(e instanceof OfflineMissError)) throw e
    // Offline: whatever is in Dexie, if this document was ever cached.
    const cached = await db.kv.get(`cache:${docId}`)
    const rows = await db.markups.where('document_id').equals(docId).toArray()
    if (!cached && !rows.length) throw e
    return { data: rows, fromCache: true } as Loaded<Markup[]>
  })
  .then(async r => {
    if (!r.fromCache) await markDocCached(docId, { markupsAt: Date.now() })
    return r
  })

export const loadAttachments = (markupId: string) => readThrough(
  () => api<AttachmentRow[]>(`/markups/${markupId}/attachments`),
  async rows => db.transaction('rw', db.attachments, async () => {
    const pending = await db.attachments.where('markup_id').equals(markupId).filter(a => !!a.pending).primaryKeys()
    await db.attachments.where('markup_id').equals(markupId).filter(a => !a.pending).delete()
    await db.attachments.bulkPut(rows.filter(r => !pending.includes(r.id)))
  }),
  async () => (await db.attachments.where('markup_id').equals(markupId).toArray()),
  'Photos',
).then(async r => {
  // Server list + photos still waiting for upload (or edited locally), oldest first.
  const local = await db.attachments.where('markup_id').equals(markupId).toArray()
  const byId = new Map<string, AttachmentRow>(local.map(a => [a.id, a]))
  const merged = r.fromCache ? local : [...r.data.map(a => byId.get(a.id) ?? a), ...local.filter(a => a.pending && !r.data.some(x => x.id === a.id))]
  merged.sort((a, b) => a.created_at.localeCompare(b.created_at))
  return { data: merged, fromCache: r.fromCache }
})

// ---------------------------------------------------------------- PDFs

/** Fetch a PDF's bytes; throws ApiError / network errors. */
async function fetchPdf(docId: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(documentFileUrl(docId), { cache: 'no-cache' })
  if (!res.ok) throw new ApiError(res.status, `Could not download the plan (${res.status})`)
  if (!res.body || !onBytes) return res.arrayBuffer()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value); total += value.length; onBytes(value.length)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out.buffer
}

/**
 * PDF bytes for a document: stored copy if present, otherwise download and store.
 * Pass the current `revisionId` (from the doc's metadata) so a copy of an older revision is replaced;
 * if that refresh can't happen because we're offline, the stored copy is used.
 * The returned buffer is a COPY (pdf.js transfers buffers to its worker and would detach ours).
 */
export async function loadPdfBytes(docId: string, revisionId?: string): Promise<ArrayBuffer> {
  const hit = await db.pdfs.get(docId)
  const stale = !!hit && !!revisionId && hit.revisionId !== revisionId
  if (hit && !stale) return hit.data.slice(0)
  let data: ArrayBuffer
  try { data = await fetchPdf(docId) } catch (e) {
    if (isOfflineError(e)) {
      if (hit) return hit.data.slice(0) // offline: an older revision beats nothing
      throw new OfflineMissError('This plan')
    }
    throw e
  }
  try {
    await db.pdfs.put({ id: docId, data, size: data.byteLength, cachedAt: Date.now(), revisionId })
    await markDocCached(docId, { pdfBytes: data.byteLength })
  } catch (e) { console.warn('could not store PDF offline', e) }
  return data.slice(0)
}

/** Forget the stored PDF (a new revision was uploaded); the next load downloads it again. */
export async function invalidatePdf(docId: string) {
  await db.pdfs.delete(docId)
  const cur = ((await db.kv.get(`cache:${docId}`))?.value ?? {}) as DocCacheState
  await db.kv.put({ key: `cache:${docId}`, value: { ...cur, pdfBytes: 0 } })
}

// ---------------------------------------------------------------- photos

/** Object URL for a locally stored photo variant, or null. Caller revokes it. */
export async function localPhotoUrl(id: string, variant: PhotoVariant): Promise<string | null> {
  const row = await db.photoBlobs.get(`${id}:${variant}`)
  return row ? URL.createObjectURL(row.blob) : null
}

/** Best-effort: store the server's rendition of a photo so it can be shown offline later. */
export async function cachePhotoView(a: Attachment): Promise<void> {
  const key = `${a.id}:view`
  if (await db.photoBlobs.get(key)) return
  try {
    const res = await fetch(attachmentFileUrl(a.id))
    if (!res.ok) return
    await db.photoBlobs.put({ key, attachment_id: a.id, variant: 'view', blob: await res.blob(), cachedAt: Date.now() })
  } catch { /* offline or storage full: it is only a cache */ }
}

// ---------------------------------------------------------------- bookkeeping & "make available offline"

export interface DocCacheState { pdfBytes?: number; markupsAt?: number; at?: number }

async function markDocCached(docId: string, patch: DocCacheState) {
  const cur = ((await db.kv.get(`cache:${docId}`))?.value ?? {}) as DocCacheState
  await db.kv.put({ key: `cache:${docId}`, value: { ...cur, ...patch, at: Date.now() } })
}

export async function docCacheStates(docIds: string[]): Promise<Map<string, DocCacheState & { offline: boolean }>> {
  const out = new Map<string, DocCacheState & { offline: boolean }>()
  for (const id of docIds) {
    const [kv, pdf] = await Promise.all([db.kv.get(`cache:${id}`), db.pdfs.get(id)])
    const v = (kv?.value ?? {}) as DocCacheState
    out.set(id, { ...v, offline: !!pdf && !!v.markupsAt })
  }
  return out
}

export async function projectCacheSize(docIds: string[]): Promise<number> {
  let n = 0
  for (const id of docIds) n += (await db.pdfs.get(id))?.size ?? 0
  const [markups, others] = await Promise.all([db.markups.toArray(), db.photoBlobs.toArray()])
  const ids = new Set(docIds)
  n += markups.filter(m => ids.has(m.document_id)).length * 1200 // rough JSON size per markup
  n += others.reduce((s, b) => s + b.blob.size, 0)
  return n
}

export interface Progress { done: number; total: number; label: string }

/**
 * Cache everything needed to work on a project with no signal: plan list, every PDF (byte-weighted
 * progress), markups, layers, symbol sets, the catalog and scales. Throws on the first hard failure.
 */
export async function makeProjectOffline(projectId: string, onProgress: (p: Progress) => void) {
  const report = (done: number, total: number, label: string) => onProgress({ done, total, label })
  report(0, 1, 'Reading project')
  await loadProject(projectId)
  const { data: docs } = await loadDocuments(projectId)
  await Promise.all([loadLayers(projectId), loadSymbolSets(), loadCatalog().catch(() => {})])

  // Progress weights: PDFs dominate, so measure by bytes where we can (HEAD-less: use count + bytes of finished)
  const total = docs.length * 4
  let done = 0
  for (const d of docs) {
    report(done, total, d.name)
    await loadDocMeta(d.id); done++
    await loadScales(d.id); done++
    await loadMarkups(d.id); done++
    const have = await db.pdfs.get(d.id)
    if (!have || have.revisionId !== d.revision_id) { // missing, or a copy of an older revision
      let got = 0
      const data = await fetchPdf(d.id, n => { got += n; report(done + Math.min(0.95, got / (got + 4_000_000)), total, d.name) })
      await db.pdfs.put({ id: d.id, data, size: data.byteLength, cachedAt: Date.now(), revisionId: d.revision_id })
      await markDocCached(d.id, { pdfBytes: data.byteLength })
    }
    done++
    report(done, total, d.name)
  }
  report(total, total, 'Done')
  return docs
}

export async function removeProjectOffline(projectId: string) {
  const docs = await db.documents.where('project_id').equals(projectId).primaryKeys()
  await db.transaction('rw', db.pdfs, db.kv, async () => {
    await db.pdfs.bulkDelete(docs)
    await db.kv.bulkDelete(docs.map(id => `cache:${id}`))
  })
}
