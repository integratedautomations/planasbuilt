import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../ui/Icon'
import { loadDocuments } from '../offline/cache'
import type { DocumentSummary } from '../api'

/** Closes `onClose` on an outside press or Escape while `open`. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [open, ref, onClose])
}

/** Plan name as a dropdown: switch to another plan (sheet set) in the same project. */
export function PlanSwitcher({ projectId, documentId, name, onPick }: { projectId: string; documentId: string; name: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  useEffect(() => {
    if (!open || docs) return
    let cancelled = false
    loadDocuments(projectId).then(r => { if (!cancelled) setDocs(r.data) }).catch(() => { if (!cancelled) setDocs([]) })
    return () => { cancelled = true }
  }, [open, docs, projectId])
  useEffect(() => { setDocs(null) }, [projectId])
  return (
    <div className="plan-switch" ref={ref}>
      <button className="plan-btn" aria-haspopup="menu" aria-expanded={open} title="Switch plan" onClick={() => setOpen(o => !o)}>
        <span className="ellipsis">{name}</span><Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="vmenu-popup left" role="menu">
          {docs === null && <div className="muted small vmenu-note">Loading plans…</div>}
          {docs?.length === 0 && <div className="muted small vmenu-note">No other plans.</div>}
          {docs?.map(d => (
            <button key={d.id} role="menuitemradio" aria-checked={d.id === documentId} className="vmenu-item"
              onClick={() => { setOpen(false); if (d.id !== documentId) onPick(d.id) }}>
              <span className="vmenu-ico">{d.id === documentId && <Icon name="check" size={16} />}</span>
              <span className="vmenu-label">{d.name}</span>
              <span className="muted small">Rev {d.revision}</span>
            </button>
          ))}
          <div className="vmenu-sep" role="separator" />
          <Link to={'/projects/' + projectId} role="menuitem" className="vmenu-item" onClick={() => setOpen(false)}>
            <span className="vmenu-ico"><Icon name="arrow-left" size={16} /></span><span className="vmenu-label">All plans in this project</span>
          </Link>
        </div>
      )}
    </div>
  )
}

/** The ⋯ menu. The body stays mounted while closed (so dialogs owned by its items keep their state). */
export function MoreMenu({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  return (
    <div className="more-wrap" ref={ref}>
      <button className={'icon-btn' + (open ? ' active' : '')} aria-haspopup="menu" aria-expanded={open} title={title} aria-label="More" onClick={() => setOpen(o => !o)}>
        <Icon name="dots" size={20} />
      </button>
      <div className="vmenu-popup right" role="menu" hidden={!open}
        onClick={e => { if ((e.target as HTMLElement).closest('[role^="menuitem"]')) setOpen(false) }}>{children}</div>
    </div>
  )
}
