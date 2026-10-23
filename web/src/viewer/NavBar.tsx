import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { DeviceSizeControl, formatDeviceScale } from './DeviceSize'
import { BOX_ICON, TOOLS } from '../markups/ToolRail'
import type { Tool } from '../markups/types'
import { MAGNET_ICON, SnapControls } from './SnapMenu'
import { usePrefs } from '../prefs/store'

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
  snapHint?: string
  /** Label of the current sheet scale, or null when none is set. */
  scaleLabel: string | null
  /** Content of the scale popover (the scale control). */
  scalePanel: ReactNode
  /** Active navigation tool and its setter; hotkeys for tooltips. */
  tool?: Tool
  onTool?: (t: Tool) => void
  hotkeys?: Record<string, string>
  /** Plan-wide device size multiplier (1 = normal) and its setter; viewers get the read-only control. */
  deviceScale?: number
  onDeviceScale?: (v: number) => void
  deviceScaleReadOnly?: boolean
  /** Box-select mode (drag on empty space selects) and its toggle. */
  boxSelect?: boolean
  onBoxSelect?: () => void
}

export const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4]

/** Floating bar at the bottom centre of the plan: page arrows and number, zoom controls and the sheet scale. */
export function NavBar({ pageNum, pageCount, onGo, zoom, onZoomBy, onFit, fitHint, prevHint, nextHint, snapHint, scaleLabel, scalePanel, tool, onTool, hotkeys, deviceScale = 1, onDeviceScale, deviceScaleReadOnly, boxSelect, onBoxSelect }: Props) {
  const snapOn = usePrefs().snap.on
  const [text, setText] = useState(String(pageNum))
  const [menu, setMenu] = useState<'zoom' | 'scale' | 'devsize' | 'snap' | null>(null)
  useEffect(() => setText(String(pageNum)), [pageNum])
  const commit = () => { const n = parseInt(text, 10); if (n) onGo(n); else setText(String(pageNum)) }
  const toggle = (m: 'zoom' | 'scale' | 'devsize' | 'snap') => setMenu(cur => (cur === m ? null : m))
  return (
    <div className="nav-bar" data-no-pan onPointerDown={e => e.stopPropagation()} role="toolbar" aria-label="Plan navigation">
      {onTool && (['select', 'pan'] as Tool[]).map(t => {
        const def = TOOLS.find(x => x.tool === t)!
        const key = hotkeys?.[`tool.${t}`]
        return <button key={t} className={'icon-btn' + (tool === t ? ' active' : '')} aria-pressed={tool === t} onClick={() => onTool(t)}
          title={key ? `${def.label} (${key})` : def.label} aria-label={def.label}>{def.icon}</button>
      })}
      {onBoxSelect && <button className={'icon-btn' + (boxSelect ? ' active' : '')} aria-pressed={!!boxSelect} onClick={onBoxSelect}
        title={`Box select${hotkeys?.['select.boxMode'] ? ` (${hotkeys['select.boxMode']})` : ''}: drag on empty space to select several`} aria-label="Box select">{BOX_ICON}</button>}
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
        <button className={'icon-btn' + (snapOn ? ' active' : '')} aria-haspopup="dialog" aria-expanded={menu === 'snap'} aria-pressed={snapOn}
          title={`Snapping ${snapOn ? 'on' : 'off'}${snapHint ? ` (${snapHint})` : ''}`} aria-label="Snapping" onClick={() => toggle('snap')}>{MAGNET_ICON}</button>
        {menu === 'snap' && <div className="nav-pop nav-snap" role="dialog" aria-label="Snapping"><SnapControls hasScale={scaleLabel !== null} hint={snapHint} /></div>}
      </span>
      {onDeviceScale && (
        <span className="nav-pop-wrap">
          <button className={'icon-btn' + (deviceScale !== 1 ? ' active' : '')} aria-haspopup="dialog" aria-expanded={menu === 'devsize'}
            title={`Device size (${formatDeviceScale(deviceScale)})`} aria-label="Device size" onClick={() => toggle('devsize')}><Icon name="device-size" size={18} /></button>
          {menu === 'devsize' && <div className="nav-pop nav-devsize" role="dialog" aria-label="Device size"><DeviceSizeControl value={deviceScale} readOnly={deviceScaleReadOnly} onChange={onDeviceScale} /></div>}
        </span>
      )}
      <span className="nav-pop-wrap">
        <button className={'scale-badge' + (scaleLabel ? '' : ' warn')} aria-haspopup="dialog" aria-expanded={menu === 'scale'} title="Sheet scale" onClick={() => toggle('scale')}>
          {scaleLabel ?? 'No scale'}
        </button>
        {menu === 'scale' && <div className="nav-pop nav-scale" role="dialog" aria-label="Sheet scale">{scalePanel}</div>}
      </span>
    </div>
  )
}
