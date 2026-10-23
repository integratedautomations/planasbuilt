import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { isValidIp } from '../markups/DeviceFields'
import type { PageScale } from '../markups/ScaleControl'
import { STATUSES } from '../markups/types'
import type { Markup, Status, SymbolSet } from '../markups/types'
import type { Change } from '../markups/useMarkups'
import { useCatalogContext } from '../catalog/useCatalog'
import { batchChanges, isUniqueFieldKey } from '../markups/mixed'
import { scaleKey } from './exportProject'
import type { ProjectScaleRow } from './exportProject'
import { ImportDialog } from './ImportDialog'
import { areaOptions, buildRows, cellText, exportFileName, exportTables, filterRows, listColumns, NO_FILTER, sortRows } from './rows'
import type { ColumnDef, RowFilter, ScheduleRow } from './rows'
import { clearTextSelection, clickSelect, guardRangeMouseDown, keySelect } from '../ui/listSelection'
import type { CableSettings } from '../markups/cables'
import './schedule.css'

export type Scope = 'sheet' | 'document' | 'project'
export interface JumpTarget { documentId: string; page: number; id: string }

interface Props {
  projectId: string
  projectName: string
  documentId: string
  documentName: string
  pageNum: number
  markups: Map<string, Markup>
  commit: (change: Change) => void
  symbolSets: Map<string, SymbolSet>
  localScales: Map<number, PageScale>
  selectedIds: string[]
  /** Replace the canvas selection (multi-select from the list). */
  onSelectIds: (ids: string[]) => void
  readOnly: boolean
  canImport: boolean
  isPhone: boolean
  /** Inside a dock zone: fills it, no own resize handle. */
  docked?: boolean
  /** Columns the user chose to show (null = all); the Tag column always stays. */
  visibleColumns?: string[] | null
  onVisibleColumns?: (ids: string[] | null) => void
  onJump: (t: JumpTarget) => void
  onClose: () => void
  /** Project cable defaults, so a cable's value is its total length. */
  cableDefaults?: CableSettings
}

const HEIGHT_KEY = 'planmark.list.height'
const PAGE = 400

const loadHeight = () => { try { return Math.max(160, Number(localStorage.getItem(HEIGHT_KEY)) || 280) } catch { return 280 } }

export function MarkupsList(p: Props) {
  const [scope, setScope] = useState<Scope>('document')
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState<RowFilter>(NO_FILTER)
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'tag', dir: 'asc' })
  const [height, setHeight] = useState(loadHeight)
  const [limit, setLimit] = useState(PAGE)
  const [projectMarkups, setProjectMarkups] = useState<Markup[] | null>(null)
  const [projectScales, setProjectScales] = useState<Map<string, number>>(new Map())
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exportError, setExportError] = useState('')

  const refresh = useCallback(() => {
    setLoadError('')
    api<Markup[]>(`/projects/${p.projectId}/markups`).then(setProjectMarkups).catch(e => setLoadError(e.message))
    api<ProjectScaleRow[]>(`/projects/${p.projectId}/scales`).then(r => setProjectScales(new Map(r.map(x => [scaleKey(x.document_id, x.page), x.points_per_foot])))).catch(() => {})
  }, [p.projectId])
  useEffect(refresh, [refresh])

  const sets = p.symbolSets
  const catalog = useCatalogContext()
  const setList = useMemo(() => [...sets.values()].sort((a, b) => a.sort - b.sort), [sets])
  const { documentId, documentName, pageNum } = p

  // Source markups per scope. The open document always comes from the live store so edits show at once.
  const source = useMemo(() => {
    const live = [...p.markups.values()]
    if (scope === 'sheet') return live.filter(m => m.page === pageNum)
    if (scope === 'document') return live
    return [...(projectMarkups ?? []).filter(m => m.document_id !== documentId), ...live]
  }, [scope, p.markups, projectMarkups, pageNum, documentId])

  const photoCounts = useMemo(() => new Map((projectMarkups ?? []).map(m => [m.id, m.photo_count ?? 0])), [projectMarkups])
  const docNames = useMemo(() => new Map([[documentId, documentName]]), [documentId, documentName])
  const scaleFor = useCallback((d: string, pg: number) =>
    d === documentId ? p.localScales.get(pg)?.pointsPerFoot ?? null : projectScales.get(scaleKey(d, pg)) ?? null,
  [documentId, p.localScales, projectScales])

  const allRows = useMemo(
    () => buildRows(source, { symbolSets: sets, catalog, docNames, photoCounts, scaleFor, showAll, cableDefaults: p.cableDefaults }),
    [source, sets, catalog, docNames, photoCounts, scaleFor, showAll, p.cableDefaults])
  const allColumns = useMemo(() => listColumns(allRows, sets, filter.setId, showAll), [allRows, sets, filter.setId, showAll])
  const columns = useMemo(() => p.visibleColumns ? allColumns.filter(c => c.id === 'tag' || p.visibleColumns!.includes(c.id)) : allColumns, [allColumns, p.visibleColumns])
  const rows = useMemo(() => sortRows(filterRows(allRows, filter), allColumns, sort.col, sort.dir), [allRows, filter, allColumns, sort])
  const areas = useMemo(() => areaOptions(allRows), [allRows])
  useEffect(() => setLimit(PAGE), [scope, filter, showAll, sort])

  const editableRow = (r: ScheduleRow) => !p.readOnly && r.isDevice && r.documentId === documentId

  /** Edits to a row that is part of a multi-selection apply to every selected device of this document, in one undo step. */
  const saveRows = (r: ScheduleRow, patch: (m: Markup) => Markup, single = false) => {
    const ids = !single && p.selectedIds.length > 1 && p.selectedIds.includes(r.id) ? p.selectedIds : [r.id]
    const changes = batchChanges(ids.map(id => p.markups.get(id)).filter((m): m is Markup => !!m), patch, m => m.type === 'device')
    if (changes.length) p.commit(changes)
  }
  const setStatus = (r: ScheduleRow, status: Status) => saveRows(r, m => ({ ...m, status }))
  // Unique fields (IP, MAC, serial) are never mass-set
  const setField = (r: ScheduleRow, key: string, value: string | number | boolean, type?: string) =>
    saveRows(r, m => ({ ...m, fields: { ...m.fields, [key]: value } }), isUniqueFieldKey(key, type))

  async function exportExcel() {
    setBusy(true); setExportError('')
    try {
      const all = buildRows(source, { symbolSets: sets, catalog, docNames, photoCounts, scaleFor, showAll: true, cableDefaults: p.cableDefaults })
      const { downloadWorkbook } = await import('./xlsxIO')
      await downloadWorkbook(exportTables(all, setList), exportFileName(p.projectName))
    } catch (e) { setExportError((e as Error).message) } finally { setBusy(false) }
  }

  // Devices of the whole project for importing: other documents from the server, this one live.
  const importDevices = useMemo(
    () => [...(projectMarkups ?? []).filter(m => m.type === 'device' && m.document_id !== documentId),
      ...[...p.markups.values()].filter(m => m.type === 'device')],
    [projectMarkups, p.markups, documentId])

  const dragRef = useRef<{ y: number; h: number } | null>(null)
  const onHandleDown = (e: React.PointerEvent) => {
    dragRef.current = { y: e.clientY, h: height }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onHandleMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setHeight(Math.round(Math.min(window.innerHeight * 0.8, Math.max(120, d.h + (d.y - e.clientY)))))
  }
  const onHandleUp = () => {
    dragRef.current = null
    try { localStorage.setItem(HEIGHT_KEY, String(height)) } catch { /* ignore */ }
  }

  const sortBy = (col: string) => setSort(s => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }))
  const shown = rows.slice(0, limit)
  const hasForeign = rows.some(r => r.documentId !== documentId)
  const selected = new Set(p.selectedIds)
  const anchor = useRef<string | null>(null)
  // Only rows of the open document can be selected on the canvas
  const order = shown.filter(r => r.documentId === documentId).map(r => r.id)
  const onRowClick = (e: React.MouseEvent, r: ScheduleRow) => {
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && r.documentId === documentId) {
      const res = clickSelect(order, { selected: p.selectedIds.filter(id => order.includes(id)), anchor: anchor.current }, r.id, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })
      anchor.current = res.anchor
      p.onSelectIds(res.selected)
      clearTextSelection()
      return
    }
    anchor.current = r.id
    p.onJump({ documentId: r.documentId, page: r.page, id: r.id })
  }

  return (
    <section className={`markups-list${p.isPhone ? ' full' : ''}${p.docked ? ' docked' : ''}`} style={p.isPhone || p.docked ? undefined : { height }} aria-label="Markups list"
      tabIndex={-1} onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => {
        if ((e.target as HTMLElement).closest('input,textarea,select')) return
        const res = keySelect(order, { selected: p.selectedIds, anchor: anchor.current }, e)
        if (res) { e.preventDefault(); e.stopPropagation(); anchor.current = res.anchor; p.onSelectIds(res.selected) }
      }}>
      {!p.isPhone && !p.docked && (
        <div className="list-handle" role="separator" aria-orientation="horizontal" aria-label="Resize list"
          onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} />
      )}
      <div className="list-bar">
        <strong className="list-title-text">Markups list</strong>
        <select aria-label="Scope" value={scope} onChange={e => { setScope(e.target.value as Scope); if (e.target.value === 'project') refresh() }}>
          <option value="sheet">This sheet</option>
          <option value="document">This document</option>
          <option value="project">Whole project</option>
        </select>
        <input type="search" className="list-search" placeholder="Search tag, fields, area" aria-label="Search"
          value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })} />
        <select aria-label="Filter by symbol set" value={filter.setId} onChange={e => setFilter({ ...filter, setId: e.target.value })}>
          <option value="">All sets</option>
          {setList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Filter by status" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
          <option value="">Any status</option>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select aria-label="Filter by area" value={filter.area} onChange={e => setFilter({ ...filter, area: e.target.value })}>
          <option value="">All areas</option>
          {areas.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <label className="check small"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show all markups</label>
        {p.onVisibleColumns && (
          <details className="col-picker">
            <summary title="Choose columns">Columns</summary>
            <div className="col-picker-menu" role="group" aria-label="Visible columns">
              {allColumns.map(c => {
                const on = c.id === 'tag' || !p.visibleColumns || p.visibleColumns.includes(c.id)
                return (
                  <label key={c.id} className="check small">
                    <input type="checkbox" checked={on} disabled={c.id === 'tag'} onChange={() => {
                      const cur = p.visibleColumns ?? allColumns.map(x => x.id)
                      p.onVisibleColumns!(cur.includes(c.id) ? cur.filter(x => x !== c.id) : [...cur, c.id])
                    }} /> {c.label}
                  </label>
                )
              })}
              {p.visibleColumns && <button className="small" onClick={() => p.onVisibleColumns!(null)}>Show all</button>}
            </div>
          </details>
        )}
        <span className="spacer" />
        <span className="muted small">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
        <button onClick={exportExcel} disabled={busy}>{busy ? 'Exporting…' : 'Export Excel'}</button>
        {p.canImport && <button onClick={() => setImporting(true)} disabled={projectMarkups === null}>Import…</button>}
        <button className="icon-btn" onClick={p.onClose} aria-label="Close list" title="Close">✕</button>
      </div>
      {(loadError || exportError) && <div className="error small list-msg">{loadError ? `Could not load the project: ${loadError}` : `Export failed: ${exportError}`}</div>}
      <div className="list-scroll">
        <table className="list-table">
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.id} aria-sort={sort.col === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button className="th-btn" onClick={() => sortBy(c.id)}>{c.label}{sort.col === c.id && <span aria-hidden> {sort.dir === 'asc' ? '▲' : '▼'}</span>}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const editable = editableRow(r)
              return (
                <tr key={r.id} className={selected.has(r.id) ? 'sel' : undefined}
                  onMouseDown={guardRangeMouseDown} onClick={e => onRowClick(e, r)}>
                  {columns.map(c => (
                    <td key={c.id} className={c.id === 'tag' ? 'cell-tag' : undefined} onClick={c.edit && editable ? e => e.stopPropagation() : undefined}>
                      <Cell row={r} col={c} editable={editable} setSet={sets} onStatus={s => setStatus(r, s)} onField={(k, v) => setField(r, k, v, c.field?.type)} />
                    </td>
                  ))}
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} className="muted list-empty">
                {projectMarkups === null && scope === 'project' && !loadError ? 'Loading…' : showAll ? 'No markups match.' : 'No devices match. Try "Show all markups".'}
              </td></tr>
            )}
          </tbody>
        </table>
        {rows.length > shown.length && (
          <div className="list-more"><button onClick={() => setLimit(l => l + PAGE)}>Show {Math.min(PAGE, rows.length - shown.length)} more of {rows.length - shown.length}</button></div>
        )}
      </div>
      {hasForeign && <div className="muted small list-msg">Rows from other plans are read-only here. Click a row to open that plan and edit.</div>}
      {importing && (
        <ImportDialog devices={importDevices} symbolSets={setList} documentId={documentId} liveMarkups={p.markups}
          commit={p.commit} onClose={() => setImporting(false)} onSavedElsewhere={refresh} />
      )}
    </section>
  )
}

function Cell({ row, col, editable, setSet, onStatus, onField }: {
  row: ScheduleRow; col: ColumnDef; editable: boolean; setSet: Map<string, SymbolSet>
  onStatus: (s: Status) => void; onField: (key: string, v: string | number | boolean) => void
}) {
  const text = cellText(row, col)
  if (col.id === 'tag') {
    return <>{text || <span className="muted">—</span>}{row.stackSize > 1 && <span className="chip" title="Devices stacked on one spot">stack ×{row.stackSize}</span>}</>
  }
  if (col.id === 'set') {
    const set = row.setId ? setSet.get(row.setId) : undefined
    return <><span className="dot" style={{ background: set?.color ?? '#868e96' }} />{text}</>
  }
  if (col.id === 'status') {
    if (!row.isDevice) return null
    if (!editable) return <StatusPill status={row.status} />
    return (
      <select className="cell-input" aria-label="Status" value={row.status} onChange={e => onStatus(e.target.value as Status)}>
        <option value="">—</option>
        {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    )
  }
  if (col.id === 'updated') return <>{text ? new Date(text).toLocaleString() : ''}</>
  if (col.field && row.isDevice && editable) {
    const def = col.field
    const v = row.fields[def.key]
    if (def.type === 'checkbox') return <input type="checkbox" aria-label={def.label} checked={!!v} onChange={e => onField(def.key, e.target.checked)} />
    if (def.type === 'select') {
      return (
        <select className="cell-input" aria-label={def.label} value={String(v ?? '')} onChange={e => onField(def.key, e.target.value)}>
          <option value="">—</option>
          {(def.options ?? []).map(o => <option key={o}>{o}</option>)}
        </select>
      )
    }
    return <TextCell value={String(v ?? '')} label={def.label} invalid={def.type === 'ip' && !isValidIp(String(v ?? ''))}
      type={def.type === 'date' ? 'date' : 'text'}
      onSave={s => onField(def.key, def.type === 'number' && s !== '' && !isNaN(+s) ? +s : s)} />
  }
  return <>{text}</>
}

function StatusPill({ status }: { status: string }) {
  const s = STATUSES.find(x => x.value === status)
  return s ? <span className="pill" style={{ background: s.color }}>{s.label}</span> : null
}

/** Commits on blur or Enter; Escape reverts. */
function TextCell({ value, label, invalid, type, onSave }: { value: string; label: string; invalid: boolean; type: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft !== value) onSave(draft) }
  return (
    <input className={`cell-input${invalid ? ' invalid' : ''}`} type={type} aria-label={label} value={draft}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setDraft(value); e.currentTarget.blur() } }} />
  )
}
