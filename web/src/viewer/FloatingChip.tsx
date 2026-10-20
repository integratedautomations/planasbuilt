import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'

/** Small pill on the canvas that opens a popover (used for the style chip and the device picker chip). */
export function FloatingChip({ summary, title, label, children }: { summary: ReactNode; title: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div ref={ref} className="float-chip" data-no-pan onPointerDown={e => e.stopPropagation()}>
      <button className="float-chip-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={title} onClick={() => setOpen(o => !o)}>
        {summary}<Icon name="chevron-down" size={14} />
      </button>
      {open && <div className="float-pop" role="dialog" aria-label={label}>{children}</div>}
    </div>
  )
}
