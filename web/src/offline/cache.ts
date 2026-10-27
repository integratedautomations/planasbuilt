/**
 * Read-through cache: try the network, store the answer in Dexie; if the network is down,
 * answer from Dexie. A server rejection (4xx) is NOT masked by the cache.
 * Throws OfflineMissError when offline and nothing is stored.
 *
 * Writes never go through here; see sync.ts.
 */
import { api, ApiError, authFetch, documentFileUrl, attachmentFileUrl } from '../api'
import type { Attachment, DocumentSummary, Project } from '../api'
import type { Layer, Markup, SymbolSet } from '../markups/types'
import type { CatalogData } from '../catalog/types'
import type { LegendPreset } from '../legend/presets'
import { isOfflineError, OfflineMissError } from './classify'
import { db } from './db'
import type { AttachmentRow, PhotoVariant, ScaleRow } from './db'
import { cacheAllowed } from './cacheOwner'
import { isForeign } from './owner'
import { ackSnapshot, getSyncUser, mergeServerMarkups } from './sync'
import { applyProjectSettings } from '../projectSettings'
import { getActiveCompanyId, getSwitchGen, setActiveCompanyId, shouldAdoptOwner } from '../company/activeCompany'
import { readScoped, replaceScoped, scopeId, stamp } from './companyScope'

/** revisions are newest first. */
export interface DocMeta { id: string; name: string; device_scale?: number; revisions: { id?: string; revision: number; page_count: number; kind?: 'upload' | 'issued' | 'restore'; label?: string }[] }
export interface ServerScale { page: number; points_per_foot: number; label: string; updated_at?: string }

export interface Loaded<T> { data: T; fromCache: boolean }

/**
 * A company-scoped answer (project list, catalog, symbol sets) arrived after the user switched company.
 * It is stored under the company it was asked for, but must not be shown: callers treat it as "ignore".
 */
export class StaleCompanyError extends Error {
  constructor() { super('The company changed while loading') }
}
export const isStale = (e: unknown) => e instanceof StaleCompanyError

/**
 * `store` and `local` receive the company that was active when the request STARTED: an answer that arrives after a
 * switch is still that company's data and is never stamped with (or replaces the cache of) the new one.
 * With `scoped`, such a late answer is stored and then rejected with StaleCompanyError so the UI drops it.
 */
async function readThrough<T>(
  fetcher: () => Promise<T>,
  store: (data: T, company: string) => Promise<unknown>,
  local: (company: string) => Promise<T | undefined>,
  what: string,
  scoped = false,
): Promise<Loaded<T>> {
  const company = scopeId()
  try {
    const data = await fetcher()
    try { await store(data, company) } catch (e) { console.warn('offline cache write failed', e) }
    if (scoped && scopeId() !== company) throw new StaleCompanyError()
    return { data, fromCache: false }
  } catch (e) {
    if (e instanceof StaleCompanyError || !isOfflineError(e)) throw e
    const data = (await cacheAllowed()) ? await local(company) : undefined
    if (data === undefined) throw new OfflineMissError(what)
    if (scoped && scopeId() !== company) throw new StaleCompanyError()
    return { data, fromCache: true }
  }
}

/** Ids of rows kept only for another user's unsent work: never shown to the signed-in user. */
async function foreignTargets(): Promise<Set<string>> {
  return new Set((await db.outbox.toArray()).filter(i => isForeign(i, getSyncUser())).map(i => i.targetId))
}

const nonEmpty = <T>(rows: T[]) => (rows.length ? rows : undefined)

/** The project list. Archived projects (asked for with `includeArchived`, admins) are never kept offline: the cached list is always the normal one. */
export const loadProjects = (includeArchived = false) => readThrough(
  () => api<Project[]>(includeArchived ? '/projects?include_archived=1' : '/projects'),
  async (rows, company) => { await db.transaction('rw', db.projects, () => replaceScoped(db.projects, rows.filter(p => !p.archived), company)) },
  async company => (await readScoped(db.projects, company)).filter(p => !p.archived),
  'Your project list',
  true,
)

/**
 * A project was archived or deleted: drop it from the cached list. Deleting also removes its plans, markups, photos, scales,
 * layers and any offline copy (listOnly keeps those: an archived project can still be opened).
 */
export async function forgetProjectLocal(projectId: string, listOnly = false) {
  if (listOnly) { await db.projects.delete(projectId); return }
  const docs = await db.documents.where('project_id').equals(projectId).primaryKeys()
  const markups = docs.length ? await db.markups.where('document_id').anyOf(docs).primaryKeys() : []
  const atts = markups.length ? await db.attachments.where('markup_id').anyOf(markups).primaryKeys() : []
  await db.transaction('rw', [db.projects, db.documents, db.pdfs, db.markups, db.layers, db.scales, db.attachments, db.photoBlobs, db.kv], async () => {
    await db.projects.delete(projectId)
    await db.documents.bulkDelete(docs)
    await db.pdfs.bulkDelete(docs)
    await db.markups.bulkDelete(markups)
    await db.layers.where('project_id').equals(projectId).delete()
    await db.scales.where('document_id').anyOf(docs).delete()
    await db.attachments.bulkDelete(atts)
    if (atts.length) await db.photoBlobs.where('attachment_id').anyOf(atts).delete()
    await db.kv.bulkDelete(docs.flatMap(id => [`cache:${id}`, `docmeta:${id}`]))
  })
}

export const loadProject = (id: string) => {
  const startedIn = getActiveCompanyId()
  const gen = getSwitchGen()
  return readThrough(
  () => api<Project>(`/projects/${id}`),
  (p, company) => db.projects.put(stamp([p], company)[0]),
  () => db.projects.get(id),
  'This project',
  ).then(r => {
  // A project belongs to one company: its catalog and settings are that company's, so follow it there.
  // The app listens for this change and remounts the pages, so the catalog and symbol sets reload for that company.
  const owner = r.data?.company_id
  if (!r.fromCache && owner && shouldAdoptOwner(startedIn, getActiveCompanyId(), owner, gen)) setActiveCompanyId(owner)
  // The project's status list and rules apply everywhere statuses are shown, online or from the offline copy.
  applyProjectSettings(r.data?.settings)
  return r
  })
}

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
  async (rows, company) => { await db.transaction('rw', db.symbolSets, () => replaceScoped(db.symbolSets, rows, company)) },
  async company => nonEmpty(await readScoped(db.symbolSets, company)),
  'Symbol sets',
  true,
)

/** Saved legend presets, kept offline per company like the catalog. */
export const loadLegendPresets = () => readThrough(
  () => api<LegendPreset[]>('/legend-presets'),
  async (rows, company) => { await db.kv.put({ key: `legendPresets:${company}`, value: rows }) },
  async company => (await db.kv.get(`legendPresets:${company}`))?.value as LegendPreset[] | undefined,
  'Legend presets',
  true,
)

export const loadCatalog = () => readThrough(
  () => api<CatalogData>('/catalog'),
  async (d, company) => {
    await db.transaction('rw', db.deviceTypes, db.products, db.cableTypes, async () => {
      await replaceScoped(db.deviceTypes, d.device_types, company)
      await replaceScoped(db.products, d.products, company)
      await replaceScoped(db.cableTypes, d.cable_types ?? [], company)
    })
  },
  async company => {
    const device_types = await readScoped(db.deviceTypes, company), products = await readScoped(db.products, company), cable_types = await readScoped(db.cableTypes, company)
    return device_types.length || products.length ? { device_types, products, cable_types } : undefined
  },
  'Catalog',
  true,
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

/**
 * The document's markups: network first (merged into Dexie so unsent local edits survive), Dexie when offline.
 * The acknowledgement snapshot is taken BEFORE the request goes out: an edit the outbox gets acknowledged after
 * that point may be missing from the (older) server list and must not be overwritten by it.
 */
export const loadMarkups = (docId: string, signal?: AbortSignal) => {
  const acked = ackSnapshot()
  return readThrough(
    () => api<Markup[]>(`/documents/${docId}/markups`, signal ? { signal } : {}),
    async () => {}, // merged below so unsent local edits survive
    async () => undefined,
    'Markups',
  ).then(async r => ({ data: await mergeServerMarkups(docId, r.data, acked), fromCache: r.fromCache }))
  .catch(async e => {
    if (!(e instanceof OfflineMissError) || !(await cacheAllowed())) throw e
    // Offline: whatever is in Dexie, if this document was ever cached.
    const cached = await db.kv.get(`cache:${docId}`)
    const rows = await db.markups.where('document_id').equals(docId).toArray()
    if (!cached && !rows.length) throw e
    return { data: rows, fromCache: true } as Loaded<Markup[]>
  })
  .then(async r => {
    if (!r.fromCache) await markDocCached(docId, { markupsAt: Date.now() })
    const theirs = await foreignTargets()
    return theirs.size ? { ...r, data: r.data.filter(m => !theirs.has(m.id)) } : r
  })
}

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
  // Rows kept for another user's unsent photo work are not ours to show.
  const theirs = await foreignTargets()
  const local = (await db.attachments.where('markup_id').equals(markupId).toArray()).filter(a => !theirs.has(a.id))
  const byId = new Map<string, AttachmentRow>(local.map(a => [a.id, a]))
  const merged = r.fromCache ? local : [...r.data.map(a => byId.get(a.id) ?? a), ...local.filter(a => a.pending && !r.data.some(x => x.id === a.id))]
  merged.sort((a, b) => a.created_at.localeCompare(b.created_at))
  return { data: merged, fromCache: r.fromCache }
})

// ---------------------------------------------------------------- PDFs

/** Fetch a PDF's bytes; throws ApiError / network errors. */
async function fetchPdf(docId: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const res = await authFetch(documentFileUrl(docId), { cache: 'no-cache' })
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
  const hit = (await cacheAllowed()) ? await db.pdfs.get(docId) : undefined
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
  const have = await db.photoBlobs.get(key)
  // Keep the copy unless the server's annotated image changed since we cached it (and nothing local is queued for it).
  if (have && (a.annotated_v === undefined || have.v === a.annotated_v || have.v === undefined && !a.has_annotation)) return
  if (have && await db.outbox.where('targetId').equals(a.id).count()) return
  try {
    const res = await authFetch(attachmentFileUrl(a.id))
    if (!res.ok) return
    await db.photoBlobs.put({ key, attachment_id: a.id, variant: 'view', blob: await res.blob(), cachedAt: Date.now(), v: a.annotated_v })
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
