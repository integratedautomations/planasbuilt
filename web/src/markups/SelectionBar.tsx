import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { STATUSES } from './types'
import type { Status } from './types'

/** Screen-space box (relative to the viewport) of the selection, or null when it cannot be placed. */
export type ScreenBox = { left: number; top: number; right: number; bottom: number } | null

interface Props {
  count: number
  canPaste: boolean
  multi: boolean
  onMulti: (v: boolean) => void
  onCopy: () => void
  onPaste: () => void
  onDelete: () => void
  /** Where the selection is on screen right now (called every frame so the bar follows pan and zoom). */
  anchor: () => ScreenBox
  /** Shown only when every selected markup is a device. */
  onReplace?: () => void
  onStatus?: (s: Status) => void
  /** Status of the first selected device, to mark it in the quick menu. */
  status?: string
  /** Opens the full context menu at this screen point. */
  onMore: (clientX: number, clientY: number) => void
  copyHint?: string
  deleteHint?: string
}

const GAP = 10

/** Floating actions beside the selected markup(s): replace, status, copy, delete and a "more" context menu. */
export function SelectionBar({ count, canPaste, multi, onMulti, onCopy, onPaste, onDelete, anchor, onReplace, onStatus, status, onMore, copyHint, deleteHint }: Props) {
  const has = count > 0
  const ref = useRef<HTMLDivElement>(null)
  const [statusOpen, setStatusOpen] = useState(false)

  // Follow the selection: the view lives in a ref (no re-render on pan), so position by hand each frame.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const el = ref.current
      const parent = el?.parentElement
      if (el && parent) {
        const box = has ? anchor() : null
        if (!box) {
          el.style.transform = 'translate(-50%, 0)'
          el.style.left = '50%'; el.style.top = '10px'
        } else {
          const w = el.offsetWidth, h = el.offsetHeight
          const cx = Math.min(Math.max((box.left + box.right) / 2, w / 2 + 6), parent.clientWidth - w / 2 - 6)
          const above = box.top - h - GAP
          const top = above >= 6 ? above : Math.min(box.bottom + GAP, parent.clientHeight - h - 70)
          el.style.left = `${cx}px`; el.style.top = `${Math.max(6, top)}px`; el.style.transform = 'translate(-50%, 0)'
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [anchor, has])

  useEffect(() => { if (!has) setStatusOpen(false) }, [has])

  return (
    <div ref={ref} className="selection-bar" data-no-pan role="toolbar" aria-label="Selection actions" onPointerDown={e => e.stopPropagation()}>
      {has && <span className="selection-count" title={`${count} selected`}>{count}</span>}
      {has && onReplace && <button className="sel-btn" onClick={onReplace} title="Replace with another device type or product" aria-label="Replace"><Icon name="replace" /></button>}
      {has && onStatus && (
        <span className="sel-pop-wrap">
          <button className="sel-btn" aria-haspopup="menu" aria-expanded={statusOpen} onClick={() => setStatusOpen(o => !o)} title="Set status" aria-label="Set status">
            <span className="status-dot" style={{ background: STATUSES.find(s => s.value === status)?.color ?? 'var(--muted)' }} />
          </button>
          {statusOpen && (
            <div className="sel-pop" role="menu" onMouseLeave={() => setStatusOpen(false)}>
              {STATUSES.map(s => (
                <button key={s.value} role="menuitemradio" aria-checked={status === s.value} className="vmenu-item" onClick={() => { setStatusOpen(false); onStatus(s.value) }}>
                  <span className="vmenu-ico"><span className="status-dot" style={{ background: s.color }} /></span>
                  <span className="vmenu-label">{s.label}</span>
                  {status === s.value && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
      {has && <button className="sel-btn" onClick={onCopy} title={`Copy${copyHint ? ` (${copyHint})` : ''}`} aria-label="Copy"><Icon name="copy" /></button>}
      {canPaste && <button className="sel-btn" onClick={onPaste} title="Paste" aria-label="Paste"><Icon name="pin" /></button>}
      {has && <button className="sel-btn danger" onClick={onDelete} title={`Delete${deleteHint ? ` (${deleteHint})` : ''}`} aria-label="Delete"><Icon name="trash" /></button>}
      <button className={'sel-btn' + (multi ? ' active' : '')} aria-pressed={multi} onClick={() => onMulti(!multi)} title="Select multiple" aria-label="Select multiple"><Icon name="list" /></button>
      {has && (
        <button className="sel-btn" title="More actions" aria-label="More actions" aria-haspopup="menu"
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onMore(r.left, r.bottom + 4) }}><Icon name="dots" /></button>
      )}
    </div>
  )
}
