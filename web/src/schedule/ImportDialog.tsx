import { useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Change } from '../markups/useMarkups'
import type { Markup, SymbolSet } from '../markups/types'
import { planImport } from './importDiff'
import type { ImportPlan, ImportSheet } from './importDiff'

interface Props {
  /** Every device in the project (the open document's devices should be the live versions). */
  devices: Markup[]
  symbolSets: SymbolSet[]
  documentId: string
  /** Live markups of the open document, so one undo step can cover its devices. */
  liveMarkups: Map<string, Markup>
  commit: (change: Change) => void
  onClose: () => void
  /** Called after devices of other documents were saved on the server. */
  onSavedElsewhere: () => void
}

export function ImportDialog({ devices, symbolSets, documentId, liveMarkups, commit, onClose, onSavedElsewhere }: Props) {
  const [sheets, setSheets] = useState<ImportSheet[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [clearBlanks, setClearBlanks] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const plan: ImportPlan | null = useMemo(
    () => (sheets ? planImport(sheets, devices, symbolSets, { clearBlanks }) : null),
    [sheets, devices, symbolSets, clearBlanks])

  async function pick(file: File | undefined) {
    if (!file) return
    setError(''); setResult(''); setFileName(file.name)
    try { setSheets(await (await import('./xlsxIO')).readWorkbook(file)) } catch (e) { setSheets(null); setError(`Could not read ${file.name}: ${(e as Error).message}`) }
  }

  async function apply() {
    if (!plan || !plan.changed.length) return
    setError('')
    const here = plan.changed.filter(c => c.markup.document_id === documentId)
    const elsewhere = plan.changed.filter(c => c.markup.document_id !== documentId)
    if (here.length) {
      // One undo step, based on the latest local versions
      const change: Change = []
      for (const c of here) {
        const before = liveMarkups.get(c.markup.id)
        if (before) change.push({ before, after: { ...before, status: c.after.status, fields: c.after.fields } })
      }
      commit(change)
    }
    let failed = 0
    if (elsewhere.length) {
      setProgress({ done: 0, total: elsewhere.length })
      for (let i = 0; i < elsewhere.length; i++) {
        const a = elsewhere[i].after
        try {
          await api(`/documents/${a.document_id}/markups/${a.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              page: a.page, type: a.type, geometry: a.geometry, style: a.style, text: a.text, layer_id: a.layer_id,
              symbol_set_id: a.symbol_set_id ?? null, tag: a.tag ?? '', status: a.status ?? '', fields: a.fields ?? {},
            }),
          })
        } catch { failed++ }
        setProgress({ done: i + 1, total: elsewhere.length })
      }
      setProgress(null)
      onSavedElsewhere()
    }
    setSheets(null)
    setResult(`Updated ${plan.changed.length - failed} device${plan.changed.length - failed === 1 ? '' : 's'}`
      + (here.length ? ` (${here.length} in this plan, undo with Ctrl+Z)` : '')
      + (failed ? `; ${failed} failed to save` : '') + '.')
  }

  const busy = !!progress
  return (
    <div className="modal-backdrop" onPointerDown={e => e.stopPropagation()}>
      <div className="card modal import-modal" role="dialog" aria-label="Import schedule from Excel">
        <div className="panel-heading">Import devices from Excel</div>
        <p className="muted small">Rows are matched to existing devices by the id column, then by Tag. Nothing new is created.</p>
        <input ref={input} type="file" hidden accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
        <div className="row">
          <button onClick={() => input.current?.click()} disabled={busy}>{fileName ? 'Choose another file…' : 'Choose file…'}</button>
          {fileName && <span className="muted small ellipsis">{fileName}</span>}
        </div>
        {error && <div className="error">{error}</div>}
        {result && <div className="import-ok">{result}</div>}
        {plan && (
          <>
            {plan.sheetsUsed.length === 0 && <div className="error">No sheet has an id or Tag column, so nothing can be matched.</div>}
            {plan.sheetsUsed.length > 0 && (
              <>
                <div><b>{plan.matched}</b> device{plan.matched === 1 ? '' : 's'} matched, <b>{plan.changed.length}</b> with changes,{' '}
                  <b>{plan.unmatched.length}</b> row{plan.unmatched.length === 1 ? '' : 's'} unmatched.</div>
                <label className="check"><input type="checkbox" checked={clearBlanks} onChange={e => setClearBlanks(e.target.checked)} />
                  Blank cells clear values</label>
                {clearBlanks && <div className="muted small">Blank cells in the file will erase the matching values on the device.</div>}
                {plan.warnings.length > 0 && <ul className="import-warn small">{plan.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
                <div className="import-scroll">
                  {plan.changed.map(c => (
                    <div key={c.markup.id} className="import-dev">
                      <div className="import-tag">{c.markup.tag || '(no tag)'}{c.markup.document_id !== documentId && <span className="muted small"> · other plan</span>}</div>
                      {c.changes.map(ch => (
                        <div key={ch.key} className="import-change small"><span className="muted">{ch.label}:</span> {ch.old || '—'} <span aria-hidden>→</span> <b>{ch.next || '(cleared)'}</b></div>
                      ))}
                    </div>
                  ))}
                  {plan.changed.length === 0 && <div className="muted">No differences to apply.</div>}
                  {plan.unmatched.length > 0 && (
                    <div className="import-dev">
                      <div className="import-tag">Unmatched rows (not imported)</div>
                      {plan.unmatched.map(u => (
                        <div key={`${u.sheet}${u.row}`} className="import-change small"><span className="muted">{u.sheet} row {u.row}:</span> {u.label} <span className="muted">({u.reason})</span></div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {progress && <div className="small">Saving {progress.done} / {progress.total}…</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={onClose} disabled={busy}>{result ? 'Close' : 'Cancel'}</button>
          <button className="primary" disabled={busy || !plan || plan.changed.length === 0} onClick={apply}>
            {plan && plan.changed.length ? `Apply ${plan.changed.length} change${plan.changed.length === 1 ? '' : 's'}` : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
