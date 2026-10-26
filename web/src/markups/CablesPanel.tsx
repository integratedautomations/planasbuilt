import { useMemo, useState } from 'react'
import type { CableType } from '../catalog/types'
import { formatLength } from '../units'
import { CABLE_ENDS, CABLE_MODE_LABEL, DEFAULT_CABLE_SETTINGS, cableMode, cableCount, cableLength, cableTypeId, chainDevices, isCable, linkedEnds } from './cables'
import type { CableSettings } from './cables'
import type { PageScale } from './ScaleControl'
import type { Markup, PathGeometry } from './types'
import './cablesPanel.css'

interface Props {
  /** Every markup of the open document. */
  markups: Map<string, Markup>
  documentId: string
  pageNum: number
  scales: Map<number, PageScale>
  cableTypes: ReadonlyMap<string, CableType>
  cableDefaults?: CableSettings
  selectedIds: string[]
  onJump: (t: { documentId: string; page: number; id: string }) => void
}

interface Row {
  m: Markup
  label: string
  typeId: string
  typeName: string
  color: string
  chain: string
  open: boolean
  runs: number
  ft: number | null
  mode: string
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

/** Dockable list of the cable runs on the current plan (or the whole document), with filters and totals per cable type. */
export function CablesPanel(p: Props) {
  const [wholeDoc, setWholeDoc] = useState(false)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [openOnly, setOpenOnly] = useState(false)

  const rows = useMemo<Row[]>(() => {
    const defaults = p.cableDefaults ?? DEFAULT_CABLE_SETTINGS
    const out: Row[] = []
    for (const m of p.markups.values()) {
      if (!isCable(m) || !m.geometry || !('points' in m.geometry)) continue
      if (!wholeDoc && m.page !== p.pageNum) continue
      const g = m.geometry as PathGeometry
      const tid = p.cableTypes.has(cableTypeId(m)) ? cableTypeId(m) : ''
      const t = p.cableTypes.get(tid)
      const tagOf = (id: string) => p.markups.get(id)?.tag || '?'
      const chain = chainDevices(g, p.markups)
      const len = cableLength(m, p.scales.get(m.page)?.pointsPerFoot ?? null, defaults, p.markups)
      out.push({
        m, label: m.tag || m.text || 'Cable', typeId: tid, typeName: t?.name ?? 'No type', color: t?.color || m.style.stroke || '#868e96',
        chain: chain.length ? chain.map(c => tagOf(c.id)).join(' → ') : '', open: linkedEnds(m, p.markups).length < CABLE_ENDS.length,
        runs: len ? len.count * len.homeRuns : cableCount(m), ft: len ? len.totalFt : null, mode: CABLE_MODE_LABEL[cableMode(m, defaults)],
      })
    }
    return out.sort((a, b) => natural(a.label, b.label) || a.m.page - b.m.page)
  }, [p.markups, p.pageNum, p.scales, p.cableTypes, p.cableDefaults, wholeDoc])

  const usedTypes = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) seen.set(r.typeId, r.typeName)
    return [...seen.entries()].sort((a, b) => natural(a[1], b[1]))
  }, [rows])

  const q = search.trim().toLowerCase()
  const shown = rows.filter(r => (!typeFilter || r.typeId === (typeFilter === '-' ? '' : typeFilter)) && (!openOnly || r.open)
    && (!q || `${r.label} ${r.typeName} ${r.chain} ${r.mode}`.toLowerCase().includes(q)))

  const totals = useMemo(() => {
    const t = new Map<string, { name: string; color: string; cables: number; runs: number; ft: number; unscaled: number }>()
    for (const r of shown) {
      const e = t.get(r.typeId) ?? { name: r.typeName, color: r.color, cables: 0, runs: 0, ft: 0, unscaled: 0 }
      e.cables++; e.runs += r.runs
      if (r.ft === null) e.unscaled++; else e.ft += r.ft
      t.set(r.typeId, e)
    }
    return [...t.entries()].sort((a, b) => natural(a[1].name, b[1].name))
  }, [shown])

  const selected = new Set(p.selectedIds)
  const showMode = shown.some(r => r.mode)

  return (
    <section className="cables-panel" aria-label="Cables">
      <div className="cables-bar">
        <input type="search" className="cables-search" placeholder="Search cables" aria-label="Search cables" value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label="Filter by cable type" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {usedTypes.map(([id, name]) => <option key={id || '-'} value={id || '-'}>{name}</option>)}
        </select>
        <label className="check small"><input type="checkbox" checked={wholeDoc} onChange={e => setWholeDoc(e.target.checked)} /> Whole document</label>
        <label className="check small"><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} /> Show open ends</label>
        <span className="spacer" />
        <span className="muted small">{shown.length} cable{shown.length === 1 ? '' : 's'}</span>
      </div>
      <div className="cables-scroll">
        <table className="list-table cables-table">
          <thead>
            <tr><th>Cable</th><th>Type</th><th>From → To</th><th>Runs</th><th>Length</th>{showMode && <th>Mode</th>}{wholeDoc && <th>Page</th>}</tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.m.id} className={selected.has(r.m.id) ? 'sel' : undefined} onClick={() => p.onJump({ documentId: r.m.document_id || p.documentId, page: r.m.page, id: r.m.id })}>
                <td className="cell-tag">{r.label}{r.open && <span className="chip" title="An end is not linked to a device">open</span>}</td>
                <td><span className="dot" style={{ background: r.color }} />{r.typeName}</td>
                <td title={r.chain}>{r.chain || <span className="muted">—</span>}</td>
                <td>{r.runs}</td>
                <td title={r.ft === null ? 'No scale set on this page' : undefined}>{r.ft === null ? <span className="muted">—</span> : formatLength(r.ft)}</td>
                {showMode && <td>{r.mode}</td>}
                {wholeDoc && <td>{r.m.page}</td>}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={5 + (showMode ? 1 : 0) + (wholeDoc ? 1 : 0)} className="muted list-empty">{rows.length ? 'No cables match.' : wholeDoc ? 'No cables in this document.' : 'No cables on this sheet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {totals.length > 0 && (
        <div className="cables-totals" aria-label="Totals per cable type">
          {totals.map(([id, t]) => (
            <span key={id || '-'} className="cables-total">
              <span className="dot" style={{ background: t.color }} /><strong>{t.name}</strong> {t.runs} run{t.runs === 1 ? '' : 's'}, {formatLength(t.ft)}
              {t.unscaled > 0 && <span className="muted"> (+{t.unscaled} unscaled)</span>}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
