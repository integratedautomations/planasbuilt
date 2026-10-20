import { useEffect, useRef, useState } from 'react'
import { BANNER_SHORT, chipSummary } from './banners'
import type { Banner } from './banners'

/** One chip, top right of the canvas, for every notice (offline, old revision, orphaned markups...). Click for the full list and actions. */
export function StatusChip({ banners }: { banners: Banner[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const sum = chipSummary(banners)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => { if (!sum) setOpen(false) }, [sum])
  if (!sum) return null
  return (
    <div ref={ref} className="status-chip-wrap" data-no-pan onPointerDown={e => e.stopPropagation()}>
      <button className={`status-chip ${sum.top.level}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)} title={sum.top.text}>
        <span className="chip-dot" />
        <span>{BANNER_SHORT[sum.top.id]}</span>
        {sum.more > 0 && <span className="chip-count">+{sum.more}</span>}
      </button>
      {open && (
        <div className="status-pop" role="dialog" aria-label="Notices">
          {sum.ordered.map(b => (
            <div key={b.id} className={`status-item ${b.level}`} role="status">
              <span className="chip-dot" />
              <span className="status-text">{b.text}</span>
              {b.action && <button className={b.action.danger ? 'danger' : ''} onClick={() => { setOpen(false); b.action!.run() }}>{b.action.label}</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
