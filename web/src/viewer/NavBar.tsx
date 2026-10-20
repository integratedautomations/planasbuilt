import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { TOOLS } from '../markups/ToolRail'
import type { Tool } from '../markups/types'

interface Props {
  pageNum: number
  pageCount: number
  onGo: (n: number) => void
  zoom: number
  onZoomBy: (factor: number) => void
  onFit: () => void
  fitHint?: string
  prevHint?: string
  nextHint?: string
  /** Label of the current sheet scale, or null when none is set. */
  scaleLabel: string | null
  /** Content of the scale popover (the scale control). */
  scalePanel: ReactNode
  /** Active navigation tool and its setter; hotkeys for tooltips. */
  tool?: Tool
  onTool?: (t: Tool) => void
  hotkeys?: Record<string, string>
}

export const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4]

/** Floating bar at the bottom centre of the plan: page arrows and number, zoom controls and the sheet scale. */
export function NavBar({ pageNum, pageCount, onGo, zoom, onZoomBy, onFit, fitHint, prevHint, nextHint, scaleLabel, scalePanel, tool, onTool, hotkeys }: Props) {
  const [text, setText] = useState(String(pageNum))
  const [menu, setMenu] = useState<'zoom' | 'scale' | null>(null)
  useEffect(() => setText(String(pageNum)), [pageNum])
  const commit = () => { const n = parseInt(text, 10); if (n) onGo(n); else setText(String(pageNum)) }
  const toggle = (m: 'zoom' | 'scale') => setMenu(cur => (cur === m ? null : m))
  return (
    <div className="nav-bar" data-no-pan onPointerDown={e => e.stopPropagation()} role="toolbar" aria-label="Plan navigation">
      {onTool && (['select', 'pan'] as Tool[]).map(t => {
        const def = TOOLS.find(x => x.tool === t)!
        const key = hotkeys?.[`tool.${t}`]
        return <button key={t} className={'icon-btn' + (tool === t ? ' active' : '')} aria-pressed={tool === t} onClick={() => onTool(t)}
          title={key ? `${def.label} (${key})` : def.label} aria-label={def.label}>{def.icon}</button>
      })}
      <button className="icon-btn" onClick={onFit} title={`Fit page${fitHint ? ` (${fitHint})` : ''}`} aria-label="Fit page"><Icon name="maximize" size={18} /></button>
      <span className="divider" />
      <button className="icon-btn" onClick={() => onGo(pageNum - 1)} disabled={pageNum <= 1} title={`Previous page (${prevHint ?? 'PageUp'})`} aria-label="Previous page"><Icon name="chevron-left" size={18} /></button>
      <span className="page-indicator">
        <input className="page-input" inputMode="numeric" value={text} aria-label="Page number"
          onChange={e => setText(e.target.value)} onBlur={commit} onFocus={e => e.target.select()}
          onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() } }} />
        <span className="muted">/ {pageCount || '…'}</span>
      </span>
      <button className="icon-btn" onClick={() => onGo(pageNum + 1)} disabled={pageNum >= pageCount} title={`Next page (${nextHint ?? 'PageDown'})`} aria-label="Next page"><Icon name="chevron-right" size={18} /></button>
      <span className="divider" />
      <button className="icon-btn" onClick={() => onZoomBy(0.8)} title="Zoom out (-)" aria-label="Zoom out"><Icon name="minus" size={18} /></button>
      <span className="nav-pop-wrap">
        <button className="zoom-label" aria-haspopup="menu" aria-expanded={menu === 'zoom'} onClick={() => toggle('zoom')} title="Zoom presets">{Math.round(zoom * 100)}%</button>
        {menu === 'zoom' && (
          <div className="nav-pop nav-menu" role="menu" onMouseLeave={() => setMenu(null)}>
            <button role="menuitem" onClick={() => { setMenu(null); onFit() }}>Fit page{fitHint ? ` (${fitHint})` : ''}</button>
            {ZOOM_PRESETS.map(z => <button key={z} role="menuitem" onClick={() => { setMenu(null); onZoomBy(z / zoom) }}>{Math.round(z * 100)}%</button>)}
          </div>
        )}
      </span>
      <button className="icon-btn" onClick={() => onZoomBy(1.25)} title="Zoom in (=)" aria-label="Zoom in"><Icon name="plus" size={18} /></button>
      <span className="divider" />
      <span className="nav-pop-wrap">
        <button className={'scale-badge' + (scaleLabel ? '' : ' warn')} aria-haspopup="dialog" aria-expanded={menu === 'scale'} title="Sheet scale" onClick={() => toggle('scale')}>
          {scaleLabel ?? 'No scale'}
        </button>
        {menu === 'scale' && <div className="nav-pop nav-scale" role="dialog" aria-label="Sheet scale">{scalePanel}</div>}
      </span>
    </div>
  )
}
