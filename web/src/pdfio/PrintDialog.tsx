import { useMemo, useState } from 'react'
import type { Layer, SymbolSet } from '../markups/types'
import { DEFAULT_PRINT, printPages } from './printOptions'
import type { PageChoice, PrintSettings } from './printOptions'

interface Props {
  pageCount: number
  currentPage: number
  layers: Layer[]
  symbolSets: SymbolSet[]
  /** Layer keys currently hidden in the viewer: they start unchecked. */
  hidden: Set<string>
  busy: boolean
  error: string
  onPrint: (s: PrintSettings) => void
  onClose: () => void
}

/** Print options: pages, fit or actual size, markups on/off and which layers. */
export function PrintDialog({ pageCount, currentPage, layers, symbolSets, hidden, busy, error, onPrint, onClose }: Props) {
  const [range, setRange] = useState<PageChoice>('all')
  const [custom, setCustom] = useState('')
  const [fit, setFit] = useState(DEFAULT_PRINT.fit)
  const [includeMarkups, setIncludeMarkups] = useState(true)
  const [off, setOff] = useState<Set<string>>(() => new Set(hidden))
  const rows = useMemo(() => [
    ...[{ id: '', name: 'Default', color: '#868e96' }, ...layers].map(l => ({ key: l.id, name: l.name, color: l.color })),
    ...symbolSets.map(s => ({ key: `set:${s.id}`, name: s.name, color: s.color })),
  ], [layers, symbolSets])
  const toggle = (key: string) => setOff(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })

  const chosen = printPages({ range, custom }, currentPage, pageCount)
  const settings: PrintSettings = { range, custom, fit, includeMarkups, hiddenLayers: [...off] }

  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <form onSubmit={e => { e.preventDefault(); if (!chosen.error) onPrint(settings) }} onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <div className="panel-heading">Print</div>
        <fieldset className="print-group">
          <legend className="small muted">Pages</legend>
          <label className="check"><input type="radio" name="range" checked={range === 'all'} onChange={() => setRange('all')} /> All ({pageCount})</label>
          <label className="check"><input type="radio" name="range" checked={range === 'current'} onChange={() => setRange('current')} /> Current page ({currentPage})</label>
          <label className="check">
            <input type="radio" name="range" checked={range === 'custom'} onChange={() => setRange('custom')} /> Pages
            <input value={custom} placeholder="1-3, 5" aria-label="Page range" onFocus={() => setRange('custom')} onChange={e => { setCustom(e.target.value); setRange('custom') }} />
          </label>
          {range === 'custom' && chosen.error && <div className="error small">{chosen.error}</div>}
        </fieldset>
        <fieldset className="print-group">
          <legend className="small muted">Size</legend>
          <label className="check"><input type="radio" name="fit" checked={fit} onChange={() => setFit(true)} /> Fit to page</label>
          <label className="check"><input type="radio" name="fit" checked={!fit} onChange={() => setFit(false)} /> Actual size</label>
        </fieldset>
        <label className="check"><input type="checkbox" checked={includeMarkups} onChange={e => setIncludeMarkups(e.target.checked)} /> Include markups</label>
        {includeMarkups && (
          <fieldset className="print-group print-layers">
            <legend className="small muted">Layers</legend>
            {rows.map(r => (
              <label key={r.key} className="check">
                <input type="checkbox" checked={!off.has(r.key)} onChange={() => toggle(r.key)} />
                <span className="dot" style={{ background: r.color }} /> {r.name}
              </label>
            ))}
          </fieldset>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !!chosen.error}>{busy ? 'Preparing…' : 'Print'}</button>
        </div>
      </form>
    </div>
  )
}
