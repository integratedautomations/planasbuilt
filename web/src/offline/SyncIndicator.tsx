import { useEffect, useRef, useState } from 'react'
import { useSocketStatus } from '../realtime/hooks'
import { useSyncStatus } from './hooks'
import { discardAllFailed, discardItem, retryAllFailed, retryItem } from './sync'
import type { OutboxItem } from './db'
import { agoText, isStale } from './unsent'
import { formatBytes, persistWarning, requestPersistence, useStorageState } from './storagePersist'
import { buildBackup, estimateExportBytes, LARGE_BYTES, parseBackup, restoreBackup, saveBackupFile } from './backup'

const KIND_LABEL: Record<OutboxItem['kind'], string> = {
  markup_put: 'Markup save', markup_delete: 'Markup delete', photo_post: 'Photo upload',
  photo_annotated: 'Photo markup', photo_caption: 'Photo caption', photo_delete: 'Photo delete',
  scale_put: 'Scale save', scale_delete: 'Scale clear',
}

/** Connection / sync state for the toolbar. Tap when there are failures to retry or discard them. */
export function SyncIndicator({ compact }: { compact?: boolean } = {}) {
  const s = useSyncStatus()
  const live = useSocketStatus()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const st = useStorageState(open)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  useEffect(() => { if (open) void requestPersistence() }, [open])
  const unsent = s.pending + s.failed
  const stale = isStale(s.oldestAt, now)

  let text = 'Online', cls = 'ok'
  if (s.foreign) { text = `Paused · ${s.foreign.count} from ${s.foreign.name}`; cls = 'bad' }
  else if (s.authRequired) { text = 'Sign in to sync'; cls = 'bad' }
  else if (s.failed) { text = `${s.failed} failed${s.pending ? ` · ${s.pending} unsent` : ''}`; cls = 'bad' }
  else if (!s.online) { text = s.pending ? `Offline · ${s.pending} unsent` : 'Offline'; cls = 'off' }
  else if (s.syncing || s.pending) { text = `Syncing · ${s.pending} unsent`; cls = 'busy' }
  else if (s.lastSyncAt) text = `Synced ${agoText(s.lastSyncAt, now)}`
  if (stale && cls !== 'bad') cls = 'bad'
  if (stale) text += ' · waiting 24h+'

  const clickable = true

  async function save() {
    setMsg('')
    try {
      if ((await estimateExportBytes()) > LARGE_BYTES && !confirm('This file will be large because of the photos. Save it anyway?')) return
      const r = await saveBackupFile(await buildBackup())
      if (r !== 'cancelled') setMsg('Saved. Keep the file until your changes have been sent.')
    } catch (e) { setMsg(`Could not save: ${(e as Error).message}`) }
  }
  async function restore(f: File | undefined) {
    if (!f) return
    setMsg('')
    const parsed = parseBackup(await f.text())
    if (!parsed.ok) { setMsg(parsed.error); return }
    try {
      const r = await restoreBackup(parsed.file)
      setMsg(`Restored ${r.restored} change${r.restored === 1 ? '' : 's'} (${r.photos} photo file${r.photos === 1 ? '' : 's'}); ${r.skipped} already queued.`)
    } catch (e) { setMsg((e as Error).message) }
  }
  // Phone: one small status dot (red problem, grey offline, amber syncing/reconnecting, green live/online).
  const state = cls === 'bad' ? 'bad' : cls === 'off' ? 'off' : (cls === 'busy' || live === 'reconnecting') ? 'busy' : 'ok'
  return (
    <span className="sync-wrap">
      {live !== 'idle' && !compact && (
        <span className={`live-dot ${live}`} role="status" title={live === 'live' ? 'Live' : 'Reconnecting…'}
          aria-label={live === 'live' ? 'Live' : 'Reconnecting'} />
      )}
      <button type="button" className={`sync-ind ${cls}${compact ? ` sync-compact st-${state}` : ''}`} disabled={!clickable}
        onClick={() => setOpen(o => !o)} aria-live="polite" title={text} aria-label={text}>
        <span className="dot" />{!compact && text}
        {!compact && live !== 'idle' && s.online && <span className="live-text hide-sm">{live === 'live' ? ' · Live' : ' · Reconnecting…'}</span>}
      </button>
      {open && clickable && <div className="sync-scrim" onClick={() => setOpen(false)} aria-hidden />}
      {open && clickable && (
        <div className="sync-pop" role="dialog" aria-label="Sync status">
          <p className="small">
            {unsent ? <strong>{unsent} unsent{s.failed ? <span style={{ color: 'var(--danger, #c00)' }}> ({s.failed} failed)</span> : null}</strong> : 'Nothing unsent.'}
            {' '}Last sync: {agoText(s.lastSyncAt, now)}.
          </p>
          {persistWarning(st) && <p className="small" role="alert">{persistWarning(st)}</p>}
          {st.usage !== null && st.quota !== null && <p className="small muted">Storage used: {formatBytes(st.usage)} of {formatBytes(st.quota)}</p>}
          {s.authRequired && <p className="small">Your session expired. Sign in again; queued changes are kept on this device.</p>}
          {s.failedItems.map(i => (
            <div key={i.seq} className="sync-item">
              <div><strong>{KIND_LABEL[i.kind]}</strong> <span className="muted small">{i.lastError}</span></div>
              <div className="row">
                <button onClick={() => retryItem(i.seq!)}>Retry</button>
                <button className="danger" onClick={() => discardItem(i.seq!)}>Discard</button>
              </div>
            </div>
          ))}
          {s.failed > 1 && (
            <div className="row">
              <button onClick={() => retryAllFailed()}>Retry all</button>
              <button className="danger" onClick={() => { if (confirm('Discard all failed changes?')) void discardAllFailed() }}>Discard all</button>
            </div>
          )}
          <div className="row">
            <button onClick={() => void save()} disabled={!unsent}>Save unsent changes to a file</button>
            <button onClick={() => fileRef.current?.click()}>Restore from file</button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden
              onChange={e => { void restore(e.target.files?.[0]); e.target.value = '' }} />
          </div>
          {msg && <p className="small" role="status">{msg}</p>}
          <button className="sync-close" onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </span>
  )
}
