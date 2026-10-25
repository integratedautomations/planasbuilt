/** Emergency export / import of unsent work (outbox items plus the photo bytes they need). No tokens are included. */
import { db, lastKnownCompany } from './db'
import type { AttachmentRow, OutboxItem, PhotoVariant } from './db'
import { getSyncUser, refreshSnapshot, kick } from './sync'

export const BACKUP_FORMAT = 'planasbuilt-unsent'
export const BACKUP_VERSION = 1
/** Warn before producing a file larger than this. */
export const LARGE_BYTES = 50 * 1024 * 1024

export interface BackupPhoto { attachment_id: string; variant: PhotoVariant; type: string; data: string }
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  userId: string | null
  userName: string | null
  companyId: string | null
  projectIds: string[]
  items: Array<Omit<OutboxItem, 'seq'> & { seq: number }>
  attachments: AttachmentRow[]
  photos: BackupPhoto[]
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out.buffer
}
const readBlob = (b: Blob): Promise<ArrayBuffer> =>
  typeof b.arrayBuffer === 'function' ? b.arrayBuffer() : new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.onerror = () => rej(r.error); r.readAsArrayBuffer(b)
  })

/** Rough size of the photo bytes that would go into an export (for the warning). */
export async function estimateExportBytes(): Promise<number> {
  const ids = await photoIds(await db.outbox.toArray())
  let n = 0
  for (const id of ids) for (const r of await db.photoBlobs.where('attachment_id').equals(id).toArray()) if (r.variant !== 'view') n += r.blob.size
  return Math.round(n * 4 / 3)
}

async function photoIds(items: OutboxItem[]): Promise<string[]> {
  return [...new Set(items.filter(i => i.kind === 'photo_post' || i.kind === 'photo_annotated').map(i => i.targetId))]
}

export async function buildBackup(): Promise<BackupFile> {
  const items = await db.outbox.orderBy('seq').toArray()
  const ids = await photoIds(items)
  const photos: BackupPhoto[] = []
  const attachments: AttachmentRow[] = []
  for (const id of ids) {
    const a = await db.attachments.get(id)
    if (a) attachments.push(a)
    for (const r of await db.photoBlobs.where('attachment_id').equals(id).toArray()) {
      if (r.variant === 'view') continue // rebuilt on restore
      photos.push({ attachment_id: id, variant: r.variant, type: r.blob.type, data: toBase64(await readBlob(r.blob)) })
    }
  }
  const docIds = new Set(items.map(i => i.docId).filter(Boolean))
  const projectIds = new Set<string>()
  for (const d of await db.documents.bulkGet([...docIds])) if (d?.project_id) projectIds.add(d.project_id)
  const user = getSyncUser()
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    userId: user?.id ?? items.find(i => i.userId)?.userId ?? null,
    userName: user?.name ?? items.find(i => i.userName)?.userName ?? null,
    companyId: lastKnownCompany(), projectIds: [...projectIds],
    items: items.map(i => ({ ...i, seq: i.seq! })), attachments, photos,
  }
}

export type ParseResult = { ok: true; file: BackupFile } | { ok: false; error: string }

/** Validate an untrusted file's text. Rejects wrong format, other versions, and malformed items. */
export function parseBackup(text: string): ParseResult {
  let j: any
  try { j = JSON.parse(text) } catch { return { ok: false, error: 'This is not a valid backup file (not JSON).' } }
  if (!j || typeof j !== 'object' || j.format !== BACKUP_FORMAT) return { ok: false, error: 'This is not a PlanAsBuilt unsent-changes file.' }
  if (j.version !== BACKUP_VERSION) return { ok: false, error: `Unsupported backup version ${String(j.version)} (expected ${BACKUP_VERSION}).` }
  if (!Array.isArray(j.items) || !Array.isArray(j.photos) || !Array.isArray(j.attachments)) return { ok: false, error: 'The backup file is incomplete.' }
  const kinds = new Set(['markup_put', 'markup_delete', 'photo_post', 'photo_annotated', 'photo_caption', 'photo_delete', 'scale_put', 'scale_delete'])
  for (const i of j.items) {
    if (!i || !kinds.has(i.kind) || typeof i.targetId !== 'string' || typeof i.docId !== 'string' || typeof i.createdAt !== 'number')
      return { ok: false, error: 'The backup file contains an invalid change.' }
  }
  const variants = new Set(['original', 'annotated'])
  for (const p of j.photos) {
    if (!p || typeof p.attachment_id !== 'string' || !variants.has(p.variant) || typeof p.data !== 'string')
      return { ok: false, error: 'The backup file contains an invalid photo.' }
  }
  return { ok: true, file: j as BackupFile }
}

export interface RestoreSummary { restored: number; skipped: number; photos: number }

/** Re-queue the file's items under the signed-in user. Items already waiting in the outbox are skipped. */
export async function restoreBackup(file: BackupFile): Promise<RestoreSummary> {
  const user = getSyncUser()
  if (!user) throw new Error('Sign in before restoring unsent changes.')
  const existing = await db.outbox.toArray()
  const sig = (i: { kind: string; targetId: string; payload: unknown }) => `${i.kind}|${i.targetId}|${JSON.stringify(i.payload)}`
  const have = new Set(existing.map(sig))
  let restored = 0, skipped = 0, photos = 0
  const restoredPhotoIds = new Set<string>()
  await db.transaction('rw', db.outbox, db.attachments, db.photoBlobs, async () => {
    for (const i of [...file.items].sort((a, b) => a.seq - b.seq)) {
      if (have.has(sig(i))) { skipped++; continue }
      have.add(sig(i))
      await db.outbox.add({
        kind: i.kind, docId: i.docId, targetId: i.targetId, payload: i.payload,
        attempts: 0, lastError: '', status: 'pending', createdAt: i.createdAt, userId: user.id, userName: user.name,
      })
      restored++
      if (i.kind === 'photo_post' || i.kind === 'photo_annotated') restoredPhotoIds.add(i.targetId)
    }
    for (const a of file.attachments) if (restoredPhotoIds.has(a.id)) await db.attachments.put({ ...a, pending: true })
    const now = Date.now()
    const byId = new Map<string, BackupPhoto[]>()
    for (const p of file.photos) if (restoredPhotoIds.has(p.attachment_id)) byId.set(p.attachment_id, [...(byId.get(p.attachment_id) ?? []), p])
    for (const [id, list] of byId) {
      const blobs = list.map(p => ({ p, blob: new Blob([fromBase64(p.data)], { type: p.type }) }))
      for (const { p, blob } of blobs) {
        await db.photoBlobs.put({ key: `${id}:${p.variant}`, attachment_id: id, variant: p.variant, blob, cachedAt: now })
        photos++
      }
      const view = blobs.find(b => b.p.variant === 'annotated') ?? blobs.find(b => b.p.variant === 'original')
      if (view) await db.photoBlobs.put({ key: `${id}:view`, attachment_id: id, variant: 'view', blob: view.blob, cachedAt: now })
    }
  })
  await refreshSnapshot()
  kick()
  return { restored, skipped, photos }
}

export const backupFileName = (d = new Date()) => `planasbuilt-unsent-${d.toISOString().slice(0, 10)}.json`

/** Save via the share sheet / File System Access when available, else a normal download. */
export async function saveBackupFile(file: BackupFile): Promise<'shared' | 'saved' | 'downloaded' | 'cancelled'> {
  const text = JSON.stringify(file)
  const name = backupFileName()
  const blob = new Blob([text], { type: 'application/json' })
  const w = window as any
  try {
    if (typeof w.showSaveFilePicker === 'function') {
      const h = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] })
      const ws = await h.createWritable(); await ws.write(blob); await ws.close()
      return 'saved'
    }
    const f = new File([blob], name, { type: 'application/json' })
    if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: 'PlanAsBuilt unsent changes' }); return 'shared' }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled'
    // fall through to a plain download
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
