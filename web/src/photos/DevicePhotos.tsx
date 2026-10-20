import { useCallback, useEffect, useRef, useState } from 'react'
import { attachmentFileUrl } from '../api'
import { useAuthedUrl } from '../useAuthedUrl'
import { cachePhotoView, loadAttachments } from '../offline/cache'
import { db } from '../offline/db'
import type { AttachmentRow } from '../offline/db'
import { useSyncStatus } from '../offline/hooks'
import { on as onSocket } from '../realtime/socket'
import { queuePhotoCaption, queuePhotoCreate, queuePhotoDelete, subscribe } from '../offline/sync'
import { uuid } from '../uuid'
import { compressPhoto } from './compress'
import { PhotoAnnotator } from './PhotoAnnotator'
import './photos.css'

type Attachment = AttachmentRow
/** Where to load a photo from: a local blob while it is unsent/offline, the server otherwise. */
type SrcFor = (a: Attachment, original?: boolean) => string
interface Props { markupId: string; readOnly: boolean }

export function DevicePhotos({ markupId, readOnly }: Props) {
  const [items, setItems] = useState<Attachment[]>([])
  const [bump, setBump] = useState<Record<string, number>>({})
  const [loadErr, setLoadErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [blobUrls, setBlobUrls] = useState<Map<string, string>>(new Map())
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const { online, pending } = useSyncStatus()

  const [reload, setReload] = useState(0)
  const shownFor = useRef('')
  // Someone else added/changed/removed a photo on this markup (or we reconnected: markupId '*').
  useEffect(() => onSocket('attachments', msg => { if (msg.markupId === markupId || msg.markupId === '*') setReload(n => n + 1) }), [markupId])

  useEffect(() => {
    let cancel = false
    if (shownFor.current !== markupId) { shownFor.current = markupId; setItems([]) }
    setLoadErr('')
    loadAttachments(markupId)
      .then(r => {
        if (cancel) return
        setItems(r.data)
        // Keep a local copy of each photo so it still shows with no signal.
        if (!r.fromCache) r.data.filter(a => !a.pending).forEach(a => { void cachePhotoView(a) })
      })
      .catch(e => { if (!cancel) setLoadErr((e as Error).message) })
    return () => { cancel = true }
  }, [markupId, reload])

  // The server accepted a photo we uploaded: swap in its row (thumbnail then points at the server).
  useEffect(() => subscribe(e => {
    if (e.type === 'attachment-adopted' && e.markupId === markupId)
      setItems(it => it.map(a => a.id === e.attachment.id ? { ...e.attachment, caption: a.caption, has_annotation: a.has_annotation || e.attachment.has_annotation } : a))
  }), [markupId])

  // Local blobs (view + original) as object URLs, and which photos still have queued writes.
  const ids = items.map(a => a.id).join(',')
  useEffect(() => {
    let cancel = false
    const made: string[] = []
    void (async () => {
      const urls = new Map<string, string>()
      for (const id of ids ? ids.split(',') : []) {
        for (const v of ['view', 'original'] as const) {
          const row = await db.photoBlobs.get(`${id}:${v}`)
          if (row) { const u = URL.createObjectURL(row.blob); made.push(u); urls.set(`${id}:${v}`, u) }
        }
      }
      const q = await db.outbox.filter(i => i.kind.startsWith('photo_')).toArray()
      if (cancel) { made.forEach(URL.revokeObjectURL); return }
      setBlobUrls(urls)
      setQueued(new Set(q.map(i => i.targetId)))
    })()
    return () => { cancel = true; setTimeout(() => made.forEach(URL.revokeObjectURL), 1000) }
  }, [ids, pending, bump])

  const srcFor: SrcFor = (a, original) => {
    const local = blobUrls.get(`${a.id}:${original ? 'original' : 'view'}`)
    if (local && (a.pending || queued.has(a.id) || !online)) return local
    return attachmentFileUrl(a.id, original ? 'original' : undefined, `${a.created_at}-${bump[a.id] ?? 0}`)
  }

  const addFiles = async (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      const id = uuid()
      try {
        const { blob, width, height } = await compressPhoto(f)
        await queuePhotoCreate({ id, markupId, blob, width, height })
        const row = await db.attachments.get(id)
        if (row) setItems(it => [...it, row])
      } catch (e) {
        setLoadErr(`${f.name}: ${(e as Error).message || 'could not process image'}`)
      }
    }
  }

  const openIdx = items.findIndex(a => a.id === openId)

  return (
    <div className="photos">
      {loadErr && <div className="photo-error">{loadErr}</div>}
      <div className="photo-grid">
        {items.map(a => (
          <button key={a.id} type="button" className="photo-thumb" onClick={() => setOpenId(a.id)} aria-label={a.caption || 'Open photo'}>
            <AuthImg src={srcFor(a)} alt={a.caption} loading="lazy" />
            {a.pending && <span className="badge">Waiting to upload</span>}
            {a.has_annotation && <span className="badge">Marked</span>}
            {a.caption && <span className="cap">{a.caption}</span>}
          </button>
        ))}
      </div>
      {!readOnly && (
        <label className="photo-add">
          + Add photo
          <input type="file" accept="image/*" capture="environment" multiple
            onChange={e => { void addFiles(e.target.files); e.target.value = '' }} />
        </label>
      )}
      {readOnly && !items.length && !loadErr && <div className="muted small">No photos.</div>}

      {openIdx >= 0 && (
        <Viewer key={openId} items={items} index={openIdx} readOnly={readOnly} srcFor={srcFor}
          onIndex={i => setOpenId(items[i].id)} onClose={() => setOpenId(null)}
          onCaption={(id, caption) => setItems(it => it.map(a => a.id === id ? { ...a, caption } : a))}
          onAnnotated={id => {
            setBump(b => ({ ...b, [id]: (b[id] ?? 0) + 1 }))
            setItems(it => it.map(a => a.id === id ? { ...a, has_annotation: true } : a))
          }}
          onDeleted={id => {
            const i = items.findIndex(a => a.id === id)
            const rest = items.filter(a => a.id !== id)
            setItems(rest)
            setOpenId(rest.length ? rest[Math.min(i, rest.length - 1)].id : null)
          }} />
      )}
    </div>
  )
}

interface ViewerProps {
  items: Attachment[]; index: number; readOnly: boolean; srcFor: SrcFor
  onIndex: (i: number) => void; onClose: () => void
  onCaption: (id: string, caption: string) => void
  onAnnotated: (id: string) => void
  onDeleted: (id: string) => void
}

/** <img> for a server file URL: fetched with the Authorization header, shown from a blob URL. */
function AuthImg({ src, ...rest }: { src: string } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const url = useAuthedUrl(src)
  return <img {...rest} src={url || undefined} />
}

function Viewer({ items, index, readOnly, srcFor, onIndex, onClose, onCaption, onAnnotated, onDeleted }: ViewerProps) {
  const a = items[index]
  const [caption, setCaption] = useState(a.caption)
  const [orig, setOrig] = useState(false)
  const [annotating, setAnnotating] = useState(false)
  const [err, setErr] = useState('')
  const touch = useRef<{ x: number; y: number } | null>(null)

  const go = useCallback((d: number) => {
    const i = index + d
    if (i >= 0 && i < items.length) onIndex(i)
  }, [index, items.length, onIndex])

  useEffect(() => {
    if (annotating) return
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [go, onClose, annotating])

  const saveCaption = async () => {
    if (readOnly || caption === a.caption) return
    setErr('')
    try {
      await queuePhotoCaption(a.id, caption)
      onCaption(a.id, caption)
    } catch (e) { setErr((e as Error).message || 'Could not save caption') }
  }

  const remove = async () => {
    if (!window.confirm('Delete this photo? This cannot be undone.')) return
    setErr('')
    try {
      await queuePhotoDelete(a.id)
      onDeleted(a.id)
    } catch (e) { setErr((e as Error).message || 'Delete failed') }
  }

  const src = srcFor(a, orig)

  return (
    <div className="photo-modal" role="dialog" aria-label="Photo viewer">
      <div className="pm-bar">
        <span className="grow">{index + 1} / {items.length}</span>
        {a.has_annotation && <button className={orig ? 'on' : ''} onClick={() => setOrig(o => !o)}>{orig ? 'Showing original' : 'View original'}</button>}
        {!readOnly && <button onClick={() => setAnnotating(true)}>Annotate</button>}
        {!readOnly && <button className="danger" onClick={remove}>Delete</button>}
        <button onClick={onClose}>Close</button>
      </div>
      <div className="pm-stage"
        onTouchStart={e => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }}
        onTouchEnd={e => {
          const t = touch.current; touch.current = null
          if (!t) return
          const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
        }}>
        <AuthImg src={src} alt={a.caption} draggable={false} />
        {index > 0 && <button className="pm-nav prev" onClick={() => go(-1)} aria-label="Previous photo">‹</button>}
        {index < items.length - 1 && <button className="pm-nav next" onClick={() => go(1)} aria-label="Next photo">›</button>}
      </div>
      <div className="pm-caption">
        {readOnly ? <span>{a.caption || 'No caption'}</span> : (
          <>
            <input value={caption} placeholder="Caption" maxLength={200} onChange={e => setCaption(e.target.value)}
              onBlur={saveCaption} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            <button onClick={saveCaption} disabled={caption === a.caption}>Save</button>
          </>
        )}
      </div>
      {err && <div className="pm-caption" style={{ color: '#ff8787' }}>{err}</div>}
      {annotating && (
        <PhotoAnnotator attachmentId={a.id} src={srcFor(a, true)} onClose={() => setAnnotating(false)}
          onSaved={() => { setAnnotating(false); setOrig(false); onAnnotated(a.id) }} />
      )}
    </div>
  )
}
