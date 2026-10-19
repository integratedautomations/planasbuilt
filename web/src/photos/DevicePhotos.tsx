import { useCallback, useEffect, useRef, useState } from 'react'
import { api, attachmentFileUrl } from '../api'
import type { Attachment } from '../api'
import { uuid } from '../uuid'
import { compressPhoto } from './compress'
import { PhotoAnnotator } from './PhotoAnnotator'
import './photos.css'

interface Local { id: string; url: string; blob: Blob; width: number; height: number; status: 'uploading' | 'error'; error?: string }
interface Props { markupId: string; readOnly: boolean }

export function DevicePhotos({ markupId, readOnly }: Props) {
  const [items, setItems] = useState<Attachment[]>([])
  const [locals, setLocals] = useState<Local[]>([])
  const [bump, setBump] = useState<Record<string, number>>({})
  const [loadErr, setLoadErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const alive = useRef(true)
  const localsRef = useRef<Local[]>([])
  localsRef.current = locals

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; localsRef.current.forEach(l => URL.revokeObjectURL(l.url)) }
  }, [])

  useEffect(() => {
    let cancel = false
    setItems([]); setLoadErr('')
    api<Attachment[]>(`/markups/${markupId}/attachments`)
      .then(r => { if (!cancel) setItems(r) })
      .catch(e => { if (!cancel) setLoadErr((e as Error).message) })
    return () => { cancel = true }
  }, [markupId])

  const upload = useCallback(async (l: Local) => {
    setLocals(ls => ls.map(x => x.id === l.id ? { ...x, status: 'uploading', error: undefined } : x))
    try {
      const fd = new FormData()
      fd.append('id', l.id); fd.append('caption', ''); fd.append('width', String(l.width)); fd.append('height', String(l.height))
      fd.append('photo', l.blob, 'photo.jpg') // file part last so the server sees fields first
      const rec = await api<Attachment>(`/markups/${markupId}/attachments`, { method: 'POST', body: fd })
      if (!alive.current) return
      setItems(it => it.some(a => a.id === rec.id) ? it : [...it, rec])
      setLocals(ls => { ls.filter(x => x.id === l.id).forEach(x => URL.revokeObjectURL(x.url)); return ls.filter(x => x.id !== l.id) })
    } catch (e) {
      if (alive.current) setLocals(ls => ls.map(x => x.id === l.id ? { ...x, status: 'error', error: (e as Error).message || 'Upload failed' } : x))
    }
  }, [markupId])

  const addFiles = async (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      const id = uuid()
      try {
        const { blob, width, height } = await compressPhoto(f)
        const l: Local = { id, url: URL.createObjectURL(blob), blob, width, height, status: 'uploading' }
        setLocals(ls => [...ls, l])
        void upload(l)
      } catch (e) {
        setLoadErr(`${f.name}: ${(e as Error).message || 'could not process image'}`)
      }
    }
  }

  const discard = (l: Local) => {
    URL.revokeObjectURL(l.url)
    setLocals(ls => ls.filter(x => x.id !== l.id))
  }

  const thumb = (a: Attachment) => attachmentFileUrl(a.id, undefined, `${a.created_at}-${bump[a.id] ?? 0}`)
  const openIdx = items.findIndex(a => a.id === openId)

  return (
    <div className="photos">
      {loadErr && <div className="photo-error">{loadErr}</div>}
      <div className="photo-grid">
        {items.map(a => (
          <button key={a.id} type="button" className="photo-thumb" onClick={() => setOpenId(a.id)} aria-label={a.caption || 'Open photo'}>
            <img src={thumb(a)} alt={a.caption} loading="lazy" />
            {a.has_annotation && <span className="badge">Marked</span>}
            {a.caption && <span className="cap">{a.caption}</span>}
          </button>
        ))}
        {locals.map(l => (
          <div key={l.id} className="photo-thumb pending">
            <img src={l.url} alt="" />
            <div className="photo-overlay">
              {l.status === 'uploading' ? <span className="spinner" aria-label="Uploading" /> : (
                <>
                  <span>{l.error}</span>
                  <button type="button" onClick={() => upload(l)}>Retry</button>
                  <button type="button" onClick={() => discard(l)}>Remove</button>
                </>
              )}
            </div>
          </div>
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
        <Viewer key={openId} items={items} index={openIdx} readOnly={readOnly} bump={bump}
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
  items: Attachment[]; index: number; readOnly: boolean; bump: Record<string, number>
  onIndex: (i: number) => void; onClose: () => void
  onCaption: (id: string, caption: string) => void
  onAnnotated: (id: string) => void
  onDeleted: (id: string) => void
}

function Viewer({ items, index, readOnly, bump, onIndex, onClose, onCaption, onAnnotated, onDeleted }: ViewerProps) {
  const a = items[index]
  const [caption, setCaption] = useState(a.caption)
  const [orig, setOrig] = useState(false)
  const [annotating, setAnnotating] = useState(false)
  const [busy, setBusy] = useState(false)
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
      await api(`/attachments/${a.id}`, { method: 'PATCH', body: JSON.stringify({ caption }) })
      onCaption(a.id, caption)
    } catch (e) { setErr((e as Error).message || 'Could not save caption') }
  }

  const remove = async () => {
    if (!window.confirm('Delete this photo? This cannot be undone.')) return
    setBusy(true); setErr('')
    try {
      await api(`/attachments/${a.id}`, { method: 'DELETE' })
      onDeleted(a.id)
    } catch (e) { setErr((e as Error).message || 'Delete failed'); setBusy(false) }
  }

  const src = attachmentFileUrl(a.id, orig ? 'original' : undefined, `${a.created_at}-${bump[a.id] ?? 0}`)

  return (
    <div className="photo-modal" role="dialog" aria-label="Photo viewer">
      <div className="pm-bar">
        <span className="grow">{index + 1} / {items.length}</span>
        {a.has_annotation && <button className={orig ? 'on' : ''} onClick={() => setOrig(o => !o)}>{orig ? 'Showing original' : 'View original'}</button>}
        {!readOnly && <button onClick={() => setAnnotating(true)}>Annotate</button>}
        {!readOnly && <button className="danger" onClick={remove} disabled={busy}>Delete</button>}
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
        <img src={src} alt={a.caption} draggable={false} />
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
        <PhotoAnnotator attachmentId={a.id} onClose={() => setAnnotating(false)}
          onSaved={() => { setAnnotating(false); setOrig(false); onAnnotated(a.id) }} />
      )}
    </div>
  )
}
