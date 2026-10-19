/**
 * Local (IndexedDB) store for offline use, via Dexie.
 *
 * Layers (see also sync.ts and cache.ts):
 *  - db.ts     schema only (this file)
 *  - cache.ts  read-through loaders: network first, Dexie on network failure
 *  - sync.ts   the outbox: every write goes to Dexie + `outbox`, a worker replays it to the server
 *
 * Rows mirror the server's JSON shapes so they can be handed straight to the UI.
 */
import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { Attachment, DocumentSummary, Project } from '../api'
import type { Layer, Markup, SymbolSet } from '../markups/types'

export type DocumentRow = DocumentSummary & { project_id: string }
export interface PdfRow { id: string; data: ArrayBuffer; size: number; cachedAt: number }
export interface ScaleRow {
  /** `${document_id}:${page}` */
  key: string; document_id: string; page: number; points_per_foot: number; label: string; updated_at?: string
}
/** Attachment metadata. `pending` = created offline and not yet accepted by the server. */
export type AttachmentRow = Attachment & { pending?: boolean }
/**
 * Photo bytes. key = `${attachment_id}:${variant}`.
 *  - 'original': the unannotated upload
 *  - 'annotated': annotated JPEG waiting to be (or already) uploaded
 *  - 'view': what the grid/viewer shows (annotated if any, else original); also filled as a cache of server photos
 */
export type PhotoVariant = 'original' | 'annotated' | 'view'
export interface PhotoBlobRow { key: string; attachment_id: string; variant: PhotoVariant; blob: Blob; cachedAt: number }

export type OutboxKind =
  | 'markup_put' | 'markup_delete'
  | 'photo_post' | 'photo_annotated' | 'photo_caption' | 'photo_delete'
  | 'scale_put' | 'scale_delete'

export interface OutboxItem {
  /** Auto-increment; defines replay order. */
  seq?: number
  kind: OutboxKind
  /** Document the write belongs to ('' when not document scoped). */
  docId: string
  /** Entity the write is about (markup id, attachment id, `${docId}:${page}` for scales). Used for coalescing. */
  targetId: string
  /** Request body / parameters; see EXECUTORS in sync.ts. */
  payload: any
  attempts: number
  lastError: string
  /** 'pending' items are drained in order; 'failed' ones (permanent 4xx) are skipped until retried or discarded. */
  status: 'pending' | 'failed'
  createdAt: number
  /** Who queued it. Items are only ever sent while this user is signed in (see owner.ts). */
  userId?: string
  userName?: string
}

/** Small key/value table: doc metadata (`docmeta:<id>`), cache bookkeeping (`cache:<docId>`), etc. */
export interface KvRow { key: string; value: any }

class OfflineDb extends Dexie {
  projects!: Table<Project, string>
  documents!: Table<DocumentRow, string>
  pdfs!: Table<PdfRow, string>
  markups!: Table<Markup, string>
  layers!: Table<Layer, string>
  symbolSets!: Table<SymbolSet, string>
  scales!: Table<ScaleRow, string>
  attachments!: Table<AttachmentRow, string>
  photoBlobs!: Table<PhotoBlobRow, string>
  outbox!: Table<OutboxItem, number>
  kv!: Table<KvRow, string>

  constructor(name = 'planmark-offline') {
    super(name)
    this.version(1).stores({
      projects: 'id',
      documents: 'id, project_id',
      pdfs: 'id',
      markups: 'id, document_id',
      layers: 'id, project_id',
      symbolSets: 'id',
      scales: 'key, document_id',
      attachments: 'id, markup_id',
      photoBlobs: 'key, attachment_id',
      outbox: '++seq, targetId, docId, status',
      kv: 'key',
    })
  }
}

export const db = new OfflineDb()

/** Wipe everything (sign-out on a shared device). Pending writes are lost, so callers should confirm. */
export async function clearLocalData() {
  await Promise.all(db.tables.map(t => t.clear()))
}
