import { useMemo, useState } from 'react'
import type { Layer, SymbolSet } from '../markups/types'
import { getPrefs, setPref } from '../prefs/store'
import { normalizePrintOptions, printPageList, QUALITY_DPI } from './printPlan'
import type { PrintMargins, PrintOptions, PrintOrientation, PrintQuality, PrintRange } from './printPlan'

interface Props {
  pageCount: number
  currentPage: number
  /** Pages picked in the Pages panel (Ctrl / Shift click), if any. */
  selectedPages: number[]
  layers: Layer[]
  symbolSets: SymbolSet[]
  /** Layer keys currently hidden in the viewer: they start unchecked. */
  hidden: Set<string>
  busy: string
  error: string
  onPrint: (o: PrintOptions, pages: number[]) => void
  onSavePdf: (o: PrintOptions, pages: number[]) => void
  onClose: () => void
  /** Options to start from (e.g. when reopened after choosing a window); defaults to the saved ones. */
  initial?: PrintOptions
  /** Hides this dialog and lets the user drag a window on the current page; the viewer reopens the dialog with the result. */
  onPickWindow?: (o: PrintOptions) => void
}

const fmtIn = (pt: number) => (Math.round(pt / 72 * 100) / 100).toString()

/** Print options: pages, size, orientation, margins, markups, layers, legend, grayscale, quality. */
export function PrintDialog({ pageCount, currentPage, selectedPages, layers, symbolSets, hidden, busy, error, onPrint, onSavePdf, onClose, initial, onPickWindow }: Props) {
  const [o, setO] = useState<PrintOptions>(() => {
    if (initial) return initial
    const saved = normalizePrintOptions(getPrefs().printOptions)
    // the layers hidden in the viewer start unchecked; "selected pages" only makes sense when some are selected
    return { ...saved, hiddenLayers: [...hidden], range: saved.range === 'selected' && !selectedPages.length ? 'all' : selectedPages.length ? 'selected' : saved.range }
  })
  const patch = (p: Partial<PrintOptions>) => setO(prev => ({ ...prev, ...p }))
  const rows = useMemo(() => [
    ...[{ id: '', name: 'Default', color: '#868e96' }, ...layers].map(l => ({ key: l.id, name: l.name, color: l.color })),
    ...symbolSets.map(s => ({ key: `set:${s.id}`, name: s.name, color: s.color })),
  ], [layers, symbolSets])
  const off = new Set(o.hiddenLayers)
  const toggle = (key: string) => patch({ hiddenLayers: off.has(key) ? o.hiddenLayers.filter(k => k !== key) : [...o.hiddenLayers, key] })

  const chosen = printPageList(o, currentPage, pageCount, selectedPages)
  const remember = () => setPref('printOptions', { ...o, hiddenLayers: [], range: o.range === 'selected' || o.range === 'custom' || o.range === 'window' ? 'all' : o.range, window: null } as unknown as Record<string, unknown>)
  const run = (fn: (o: PrintOptions, pages: number[]) => void) => () => { if (!chosen.error) { remember(); fn(o, chosen.pages) } }
  const range = (r: PrintRange, label: string, disabled = false) => (
    <label className="check"><input type="radio" name="range" disabled={disabled} checked={o.range === r} onChange={() => patch({ range: r })} /> {label}</label>
  )

  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <form className="report-dialog" onSubmit={e => { e.preventDefault(); run(onPrint)() }} onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <div className="panel-heading">Print</div>
        <p className="muted small">
          Next, your browser&apos;s print dialog opens. There you choose the printer, paper size, copies and two-sided printing; browsers can&apos;t
          read a printer&apos;s paper sizes directly, so each page is sent at the size of the paper you pick and scaled to fit it.
        </p>
        <fieldset className="print-group">
          <legend className="small muted">Pages</legend>
          {range('all', `All (${pageCount})`)}
          {range('current', `Current page (${currentPage})`)}
          {range('selected', `Selected in Pages panel${selectedPages.length ? ` (${selectedPages.length})` : ''}`, !selectedPages.length)}
          <label className="check">
            <input type="radio" name="range" checked={o.range === 'custom'} onChange={() => patch({ range: 'custom' })} /> Pages
            <input value={o.custom} placeholder="1-3, 5" aria-label="Page range" onFocus={() => patch({ range: 'custom' })} onChange={e => patch({ custom: e.target.value, range: 'custom' })} />
          </label>
          {onPickWindow && (
            <div className="check">
              <label className="check"><input type="radio" name="range" checked={o.range === 'window'}
                onChange={() => { if (o.window) patch({ range: 'window' }); else onPickWindow({ ...o, range: 'window' }) }} /> Window (drag a rectangle on the current page)</label>
              {o.range === 'window' && o.window && (
                <span className="small muted"> Page {o.window.page}: {fmtIn(o.window.width)} × {fmtIn(o.window.height)} in{' '}
                  <button type="button" onClick={() => onPickWindow(o)}>Reselect</button></span>
              )}
            </div>
          )}
          {chosen.error && <div className="error small">{chosen.error}</div>}
        </fieldset>
        <fieldset className="print-group">
          <legend className="small muted">Size</legend>
          <label className="check"><input type="radio" name="fit" checked={o.fit} onChange={() => patch({ fit: true })} /> Fit to page</label>
          <label className="check"><input type="radio" name="fit" checked={!o.fit} onChange={() => patch({ fit: false })} /> Actual size (1 PDF point = 1/72 inch)</label>
        </fieldset>
        <div className="grid2">
          <label className="field">Orientation
            <select value={o.orientation} onChange={e => patch({ orientation: e.target.value as PrintOrientation })}>
              <option value="auto">Automatic (per page)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option>
            </select>
          </label>
          <label className="field">Margins
            <select value={o.margins} onChange={e => patch({ margins: e.target.value as PrintMargins })}>
              <option value="none">None</option><option value="narrow">Narrow (0.25 in)</option><option value="normal">Normal (0.5 in)</option>
            </select>
          </label>
          <label className="field">Quality
            <select value={o.quality} onChange={e => patch({ quality: e.target.value as PrintQuality })}>
              <option value="draft">Draft ({QUALITY_DPI.draft} dpi)</option><option value="normal">Normal ({QUALITY_DPI.normal} dpi)</option><option value="high">High ({QUALITY_DPI.high} dpi)</option>
            </select>
          </label>
        </div>
        <label className="check"><input type="checkbox" checked={o.grayscale} onChange={e => patch({ grayscale: e.target.checked })} /> Print in grayscale</label>
        <label className="check"><input type="checkbox" checked={o.includeMarkups} onChange={e => patch({ includeMarkups: e.target.checked })} /> Include markups</label>
        {o.includeMarkups && (
          <>
            <label className="check"><input type="checkbox" checked={o.includeLegend} onChange={e => patch({ includeLegend: e.target.checked })} /> Include legends</label>
            <fieldset className="print-group print-layers">
              <legend className="small muted">Layers</legend>
              {rows.map(r => (
                <label key={r.key} className="check">
                  <input type="checkbox" checked={!off.has(r.key)} onChange={() => toggle(r.key)} />
                  <span className="dot" style={{ background: r.color }} /> {r.name}
                </label>
              ))}
            </fieldset>
          </>
        )}
        {busy && <div className="muted small" role="status">{busy}</div>}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <span className="spacer" />
          <button type="button" disabled={!!busy || !!chosen.error || o.range === 'window'} onClick={run(onSavePdf)} title="Download a print-ready PDF instead of printing now">Save as PDF</button>
          <button type="submit" className="primary" disabled={!!busy || !!chosen.error}>{busy ? 'Preparing…' : 'Print…'}</button>
        </div>
      </form>
    </div>
  )
}
