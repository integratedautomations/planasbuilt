import { useState } from 'react'
import { useSocketStatus } from '../realtime/hooks'
import { useSyncStatus } from './hooks'
import { discardAllFailed, discardItem, retryAllFailed, retryItem } from './sync'
import type { OutboxItem } from './db'

const KIND_LABEL: Record<OutboxItem['kind'], string> = {
  markup_put: 'Markup save', markup_delete: 'Markup delete', photo_post: 'Photo upload',
  photo_annotated: 'Photo markup', photo_caption: 'Photo caption', photo_delete: 'Photo delete',
  scale_put: 'Scale save', scale_delete: 'Scale clear',
}

/** Connection / sync state for the toolbar. Tap when there are failures to retry or discard them. */
export function SyncIndicator() {
  const s = useSyncStatus()
  const live = useSocketStatus()
  const [open, setOpen] = useState(false)

  let text = 'Online', cls = 'ok'
  if (s.foreign) { text = `Paused · ${s.foreign.count} from ${s.foreign.name}`; cls = 'bad' }
  else if (s.authRequired) { text = 'Sign in to sync'; cls = 'bad' }
  else if (s.failed) { text = `${s.failed} failed`; cls = 'bad' }
  else if (!s.online) { text = s.pending ? `Offline · ${s.pending} queued` : 'Offline'; cls = 'off' }
  else if (s.syncing || s.pending) { text = `Syncing ${s.pending}`; cls = 'busy' }

  const clickable = s.failed > 0 || s.authRequired
  return (
    <span className="sync-wrap">
      {live !== 'idle' && (
        <span className={`live-dot ${live}`} role="status" title={live === 'live' ? 'Live' : 'Reconnecting…'}
          aria-label={live === 'live' ? 'Live' : 'Reconnecting'} />
      )}
      <button type="button" className={`sync-ind ${cls}`} disabled={!clickable}
        onClick={() => setOpen(o => !o)} aria-live="polite" title={text}>
        <span className="dot" />{text}
        {live !== 'idle' && s.online && <span className="live-text hide-sm">{live === 'live' ? ' · Live' : ' · Reconnecting…'}</span>}
      </button>
      {open && clickable && (
        <div className="sync-pop" role="dialog" aria-label="Sync problems">
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
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </span>
  )
}
