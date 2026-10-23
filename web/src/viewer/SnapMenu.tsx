import { useEffect, useState } from 'react'
import { setPref, usePrefs } from '../prefs/store'
import type { SnapSettings } from '../markups/snapConfig'
import { GRID_MAX, GRID_MIN } from '../markups/snapConfig'

export const MAGNET_ICON = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3v8a6 6 0 0012 0V3" /><path d="M6 7h4M14 7h4" />
  </svg>
)

const SOURCES: { key: 'grid' | 'pdf' | 'markups' | 'devices' | 'align'; label: string; hint: string }[] = [
  { key: 'grid', label: 'Grid', hint: 'Snap to grid points' },
  { key: 'pdf', label: 'PDF lines', hint: 'Snap to lines and corners drawn in the plan' },
  { key: 'markups', label: 'Markups', hint: 'Snap to the corners, midpoints and edges of markups' },
  { key: 'devices', label: 'Devices', hint: 'Snap to device centres' },
  { key: 'align', label: 'Align to walls', hint: 'Turn devices and boxes to the line they snap to' },
]

const setSnap = (cur: SnapSettings, patch: Partial<SnapSettings>) => setPref('snap', { ...cur, ...patch })

/** Spacing field: commits on blur / Enter so typing "0.5" does not snap the grid on every keystroke. */
function GridSpacing({ snap, hasScale }: { snap: SnapSettings; hasScale: boolean }) {
  const value = hasScale ? snap.gridFeet : snap.gridPoints
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = parseFloat(text)
    if (isFinite(n) && n >= GRID_MIN && n <= GRID_MAX) setSnap(snap, hasScale ? { gridFeet: n } : { gridPoints: n })
    else setText(String(value))
  }
  return (
    <label className="snap-row snap-spacing">
      <span>Grid spacing</span>
      <input inputMode="decimal" value={text} aria-label={`Grid spacing in ${hasScale ? 'feet' : 'points'}`}
        onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      <span className="muted small">{hasScale ? 'ft' : 'pt'}</span>
    </label>
  )
}

/** The snap toggles: master switch, one per source, show-grid and grid spacing. Remembered per user (prefs). */
export function SnapControls({ hasScale, hint }: { hasScale: boolean; hint?: string }) {
  const snap = usePrefs().snap
  return (
    <div className="snap-menu">
      <label className="snap-row snap-master">
        <input type="checkbox" checked={snap.on} onChange={e => setSnap(snap, { on: e.target.checked })} />
        <strong>Snapping</strong>{hint && <span className="muted small">({hint})</span>}
      </label>
      {SOURCES.map(s => (
        <label key={s.key} className="snap-row" title={s.hint}>
          <input type="checkbox" checked={snap[s.key]} disabled={!snap.on} onChange={e => setSnap(snap, { [s.key]: e.target.checked })} />
          <span>{s.label}</span>
        </label>
      ))}
      <label className="snap-row">
        <input type="checkbox" checked={snap.showGrid} onChange={e => setSnap(snap, { showGrid: e.target.checked })} />
        <span>Show grid</span>
      </label>
      <GridSpacing snap={snap} hasScale={hasScale} />
      <p className="muted small snap-note">Hold Ctrl to place without snapping.</p>
    </div>
  )
}
