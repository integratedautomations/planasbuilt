import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DOCKS } from '../prefs/layout'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import type { Dock, PanelId } from '../prefs/layout'

export interface DockPanel { id: PanelId; title: string; node: ReactNode }
/** A panel shown as an icon on the collapsed strip. */
export interface StripPanel { id: PanelId; title: string; icon: IconName }

interface Props {
  side: Dock
  panels: DockPanel[]
  active: PanelId
  onActive: (id: PanelId) => void
  size: number
  onSize: (n: number) => void
  onMove: (id: PanelId, dock: Dock) => void
  onHide: (id: PanelId) => void
}

/** A closed dock: a thin strip with one icon per panel docked here; a click reopens the dock on that panel. Nothing when the dock holds no panels. */
export function DockStrip({ side, panels, active, onOpen }: { side: Dock; panels: StripPanel[]; active?: PanelId; onOpen: (id: PanelId) => void }) {
  if (!panels.length) return null
  const cur = panels.find(p => p.id === active) ?? panels[0]
  return (
    <section className={`dock-strip dock-strip-${side}`} aria-label={`${side} dock (collapsed)`} onPointerDown={e => e.stopPropagation()}>
      {panels.map(p => (
        <button key={p.id} className={'icon-btn' + (p.id === cur.id ? ' active' : '')} title={p.title} aria-label={`Open ${p.title}`} onClick={() => onOpen(p.id)}>
          <Icon name={p.icon} size={18} />
        </button>
      ))}
    </section>
  )
}

const ICONS: Record<Dock, IconName> = { left: 'sidebar-left', right: 'sidebar-right', bottom: 'sidebar-bottom' }

/** One dock area beside the plan: tab strip (one tab per open panel), dock menu, resizable splitter. */
export function DockZone({ side, panels, active, onActive, size, onSize, onMove, onHide }: Props) {
  const [menu, setMenu] = useState(false)
  const [live, setLive] = useState<number | null>(null)
  const drag = useRef<{ start: number; size: number } | null>(null)
  if (!panels.length) return null
  const current = panels.find(p => p.id === active) ?? panels[0]
  const horizontal = side === 'bottom'

  const down = (e: React.PointerEvent) => {
    drag.current = { start: horizontal ? e.clientY : e.clientX, size }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const delta = (horizontal ? e.clientY : e.clientX) - d.start
    // The splitter is on the inner edge: dragging toward the plan grows the zone for left, shrinks it for right/bottom.
    setLive(Math.round(d.size + (side === 'left' ? delta : -delta)))
  }
  const up = () => {
    if (drag.current && live !== null) onSize(live)
    drag.current = null
    setLive(null)
  }
  const px = live ?? size
  const bar = (
    <div className={`dock-splitter ${horizontal ? 'h' : 'v'}`} role="separator" aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-label={`Resize ${side} dock`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
  )

  return (
    <section className={`dock-zone dock-${side}`} style={horizontal ? { height: px } : { width: px }} aria-label={`${side} dock`} onPointerDown={e => e.stopPropagation()}>
      {side !== 'left' && bar}
      <div className="dock-inner">
        <div className="dock-head">
          <div className="dock-tabs" role="tablist">
            {panels.map(p => (
              <button key={p.id} role="tab" aria-selected={p.id === current.id} className={p.id === current.id ? 'active' : ''} onClick={() => onActive(p.id)}>{p.title}</button>
            ))}
          </div>
          <div className="dock-menu-wrap">
            <button className="icon-btn small" aria-haspopup="menu" aria-expanded={menu} title={`Dock ${current.title}`} aria-label={`Dock ${current.title}`} onClick={() => setMenu(m => !m)}><Icon name={ICONS[side]} size={16} /></button>
            {menu && (
              <div className="dock-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                {DOCKS.map(d => (
                  <button key={d} role="menuitemradio" aria-checked={d === side} onClick={() => { setMenu(false); onMove(current.id, d) }}>
                    {d === side ? <Icon name="check" size={14} /> : null} Dock {d}
                  </button>
                ))}
                <button role="menuitem" onClick={() => { setMenu(false); onHide(current.id) }}>Hide</button>
              </div>
            )}
          </div>
        </div>
        <div className="dock-body">{current.node}</div>
      </div>
      {side === 'left' && bar}
    </section>
  )
}
