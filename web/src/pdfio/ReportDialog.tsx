import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { DocumentSummary } from '../api'
import { STATUSES } from '../markups/types'
import type { SymbolSet } from '../markups/types'
import { getPrefs, setPref } from '../prefs/store'
import { loadCompany } from '../settings/company'
import { normalizeReportOptions, pageRangeError, rememberableOptions } from './reportOptions'
import type { ReportGroupBy, ReportOptions, ReportPhotos, PhotosPerPage } from './reportOptions'

interface Props {
  projectName: string
  docs: DocumentSummary[]
  busy: boolean
  onGenerate: (o: ReportOptions) => void
  onClose: () => void
}

const STATUS_CHOICES = [...STATUSES.map(s => ({ value: s.value as string, label: s.label })), { value: 'none', label: 'No status' }]

/** Options asked before the as-built report is built. Last choices are remembered in the user prefs. */
export function ReportDialog({ projectName, docs, busy, onGenerate, onClose }: Props) {
  const [o, setO] = useState<ReportOptions>(() => normalizeReportOptions(getPrefs().reportOptions))
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [docOn, setDocOn] = useState<Set<string>>(() => new Set(docs.map(d => d.id)))
  const [statusOn, setStatusOn] = useState<Set<string>>(() => new Set(o.statuses.length ? o.statuses : STATUS_CHOICES.map(s => s.value)))
  const [setOn, setSetOn] = useState<Set<string> | null>(null)
  // Company settings fill the title page fields the user has not filled in before.
  useEffect(() => {
    let live = true
    void loadCompany().then(c => {
      if (!c || !live) return
      setO(prev => ({
        ...prev,
        companyName: prev.companyName || c.name,
        address: prev.address || c.address,
        preparedBy: prev.preparedBy || c.prepared_by,
      }))
    })
    return () => { live = false }
  }, [])
  useEffect(() => { api<SymbolSet[]>('/symbol-sets').then(s => { setSets(s); setSetOn(new Set(s.map(x => x.id))) }).catch(() => {}) }, [])
  const patch = (p: Partial<ReportOptions>) => setO(prev => ({ ...prev, ...p }))
  const toggle = <T,>(s: Set<T>, v: T) => { const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n }
  const rangeErrors = useMemo(() => Object.fromEntries(docs.map(d => [d.id, pageRangeError(o.pageRanges[d.id] ?? '', d.page_count)])), [docs, o.pageRanges])
  const hasError = Object.entries(rangeErrors).some(([id, e]) => e && docOn.has(id))
  const nothing = docOn.size === 0 || (!o.includeSheets && !o.includeDevices && !o.titlePage)

  function submit() {
    const final: ReportOptions = {
      ...o,
      docIds: docOn.size === docs.length ? null : [...docOn],
      statuses: statusOn.size === STATUS_CHOICES.length ? [] : [...statusOn],
      setIds: !setOn || setOn.size === sets.length ? [] : [...setOn],
    }
    setPref('reportOptions', rememberableOptions(final) as unknown as Record<string, unknown>)
    onGenerate(final)
  }

  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <form className="report-dialog" onSubmit={e => { e.preventDefault(); if (!hasError && !nothing) submit() }} onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <div className="panel-heading">As-built report</div>

        <fieldset className="print-group">
          <legend className="small muted">Title page</legend>
          <label className="check"><input type="checkbox" checked={o.titlePage} onChange={e => patch({ titlePage: e.target.checked })} /> Include a title page</label>
          {o.titlePage && (
            <>
              <div className="muted small">Project: {projectName}</div>
              <label className="field">Address<textarea rows={2} value={o.address} onChange={e => patch({ address: e.target.value })} /></label>
              <label className="field">Company name<input value={o.companyName} onChange={e => patch({ companyName: e.target.value })} /></label>
              <label className="field">Prepared by<input value={o.preparedBy} onChange={e => patch({ preparedBy: e.target.value })} /></label>
              <label className="field">Date (blank = today)<input type="date" value={o.date} onChange={e => patch({ date: e.target.value })} /></label>
            </>
          )}
        </fieldset>

        <fieldset className="print-group">
          <legend className="small muted">Plans and pages</legend>
          {docs.map(d => (
            <div key={d.id} className="report-doc">
              <label className="check"><input type="checkbox" checked={docOn.has(d.id)} onChange={() => setDocOn(prev => toggle(prev, d.id))} /> {d.name} <span className="muted">({d.page_count})</span></label>
              {docOn.has(d.id) && d.page_count > 1 && (
                <input value={o.pageRanges[d.id] ?? ''} placeholder="All pages, or e.g. 1-3, 5" aria-label={`Pages of ${d.name}`}
                  className={rangeErrors[d.id] ? 'invalid' : ''} onChange={e => patch({ pageRanges: { ...o.pageRanges, [d.id]: e.target.value } })} />
              )}
              {docOn.has(d.id) && rangeErrors[d.id] && <div className="error small">{rangeErrors[d.id]}</div>}
            </div>
          ))}
        </fieldset>

        <fieldset className="print-group">
          <legend className="small muted">Contents</legend>
          <label className="check"><input type="checkbox" checked={o.includeSheets} onChange={e => patch({ includeSheets: e.target.checked })} /> Sheets (flattened plans with markups)</label>
          <label className="check"><input type="checkbox" checked={o.includeDevices} onChange={e => patch({ includeDevices: e.target.checked })} /> Device pages</label>
          <label className="check"><input type="checkbox" checked={o.includeLegend} onChange={e => patch({ includeLegend: e.target.checked })} /> Legend summary (device counts)</label>
          <label className="check"><input type="checkbox" checked={o.includeBom} onChange={e => patch({ includeBom: e.target.checked })} /> Bill of materials summary</label>
        </fieldset>

        {o.includeDevices && (
          <fieldset className="print-group">
            <legend className="small muted">Devices</legend>
            <div className="small muted">Status</div>
            <div className="row wrap">
              {STATUS_CHOICES.map(s => (
                <label key={s.value} className="check"><input type="checkbox" checked={statusOn.has(s.value)} onChange={() => setStatusOn(prev => toggle(prev, s.value))} /> {s.label}</label>
              ))}
            </div>
            {sets.length > 1 && setOn && (
              <>
                <div className="small muted">Symbol set</div>
                <div className="row wrap">
                  {sets.map(s => (
                    <label key={s.id} className="check"><input type="checkbox" checked={setOn.has(s.id)} onChange={() => setSetOn(prev => toggle(prev ?? new Set(), s.id))} />
                      <span className="dot" style={{ background: s.color }} /> {s.name}</label>
                  ))}
                </div>
              </>
            )}
            <label className="field">Group devices by
              <select value={o.groupBy} onChange={e => patch({ groupBy: e.target.value as ReportGroupBy })}>
                <option value="sheet">Sheet</option>
                <option value="area">Area</option>
                <option value="set">Symbol set</option>
              </select>
            </label>
            <label className="field">Photos
              <select value={o.photos} onChange={e => patch({ photos: e.target.value as ReportPhotos })}>
                <option value="all">All photos</option>
                <option value="first">First photo only</option>
                <option value="none">No photos</option>
              </select>
            </label>
            {o.photos !== 'none' && (
              <label className="field">Photos per page
                <select value={o.photosPerPage} onChange={e => patch({ photosPerPage: Number(e.target.value) as PhotosPerPage })}>
                  <option value={2}>2</option><option value={4}>4</option><option value={6}>6</option>
                </select>
              </label>
            )}
            <label className="check"><input type="checkbox" checked={o.includeEmptyFields} onChange={e => patch({ includeEmptyFields: e.target.checked })} /> Include empty fields</label>
          </fieldset>
        )}

        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || hasError || nothing}>{busy ? 'Building…' : 'Generate report'}</button>
        </div>
      </form>
    </div>
  )
}
