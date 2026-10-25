import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../ui/Icon'
import { loadDocuments, loadProject } from '../offline/cache'
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

/** The project's name as a link back to its plans, shown in front of the plan name. Hidden on phones (the back arrow does the job). */
export function ProjectCrumb({ projectId }: { projectId: string }) {
  const [name, setName] = useState('')
  useEffect(() => { let live = true; loadProject(projectId).then(r => { if (live) setName(r.data.name) }).catch(() => {}); return () => { live = false } }, [projectId])
  if (!name) return null
  return <><Link to={'/projects/' + projectId} className="proj-crumb ellipsis" title={`Project: ${name}`}>{name}</Link><span className="muted proj-crumb-sep" aria-hidden>/</span></>
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

export interface SheetTab { id: string; label: string; node: ReactNode }

/**
 * The ⋯ menu. The body stays mounted while closed (so dialogs owned by its items keep their state).
 * With `sheet` (phones) it opens as a bottom sheet over a scrim: File | View | Scale | Snap tabs, Esc / the back button /
 * the scrim close it, and the content scrolls inside a capped height.
 */
export function MoreMenu({ title, children, sheet }: { title: string; children: ReactNode; sheet?: SheetTab[] }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState(sheet?.[0]?.id ?? '')
  const ref = useRef<HTMLDivElement>(null)
  const sheeted = !!sheet
  useDismiss(open && !sheeted, ref, () => setOpen(false))
  // Sheet: Escape closes it, and the browser/phone back button closes it instead of leaving the plan.
  useEffect(() => {
    if (!open || !sheeted) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const pop = () => setOpen(false)
    window.addEventListener('keydown', key)
    window.addEventListener('popstate', pop)
    try { history.pushState({ ...(history.state ?? {}), moreSheet: true }, '') } catch { /* ignore */ }
    return () => {
      window.removeEventListener('keydown', key); window.removeEventListener('popstate', pop)
      try { if (history.state?.moreSheet) history.back() } catch { /* ignore */ }
    }
  }, [open, sheeted])
  const closeOnItem = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest('[role^="menuitem"]')) setOpen(false) }
  return (
    <div className="more-wrap" ref={ref}>
      <button className={'icon-btn' + (open ? ' active' : '')} aria-haspopup={sheeted ? 'dialog' : 'menu'} aria-expanded={open} title={title} aria-label="More" onClick={() => setOpen(o => !o)}>
        <Icon name="dots" size={20} />
      </button>
      {sheeted ? (
        <>
          {open && <div className="sheet-scrim" onClick={() => setOpen(false)} aria-hidden />}
          <div className="more-sheet" role="dialog" aria-label="More" aria-modal={open} hidden={!open}>
            <div className="more-sheet-grip" aria-hidden />
            <div className="more-sheet-tabs" role="tablist">
              {sheet.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
              <button className="icon-btn more-sheet-close" aria-label="Close menu" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button>
            </div>
            <div className="more-sheet-body" onClick={closeOnItem}>
              {sheet.map(t => <div key={t.id} role="tabpanel" hidden={tab !== t.id} className="more-sheet-panel">{t.node}</div>)}
            </div>
          </div>
        </>
      ) : (
        <div className="vmenu-popup right" role="menu" hidden={!open} onClick={closeOnItem}>{children}</div>
      )}
    </div>
  )
}
