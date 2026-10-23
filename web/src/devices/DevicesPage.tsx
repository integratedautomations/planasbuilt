import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { DocumentSummary, Project, User } from '../api'
import { Brand } from '../Brand'
import { CatalogContext, useCatalog } from '../catalog/useCatalog'
import { fieldDefsFor } from '../catalog/catalog'
import { describeBlocked, gateStatus, lockedFor } from '../projectSettings'
import { DeviceFields } from '../markups/DeviceFields'
import { HARDWARE_FIELDS, STATUSES } from '../markups/types'
import type { FieldDef, Markup, Status, SymbolSet } from '../markups/types'
import { loadDocuments, loadProject, loadSymbolSets } from '../offline/cache'
import { OfflineBanner } from '../offline/OfflineBanner'
import { queueMarkupPut } from '../offline/sync'
import { RoleContext } from '../roleContext'
import { can, isFieldOnly } from '../roles'
import { areaOptions, buildRows, exportFileName, exportTables } from '../schedule/rows'
import type { ScheduleRow } from '../schedule/rows'
import { UserMenu } from '../settings/UserMenu'
import { clearTextSelection, clickSelect, emptySel, keySelect, selectAll } from '../ui/listSelection'
import type { ListSel } from '../ui/listSelection'
import { isUniqueFieldKey } from '../markups/mixed'
import { bulkField, bulkStatus, DEVICE_COLUMNS, deviceCell, displayOrder, filterDevices, GROUP_OPTIONS, groupDevices, NO_DEVICE_FILTER, planOptions, sortDevices } from './deviceList'
import type { BulkResult, DeviceFilter, GroupBy } from './deviceList'
import { loadProjectDevices } from './loadDevices'
import './devices.css'

const PAGE = 300
const NOTES: FieldDef = { key: 'notes', label: 'Notes', type: 'text' }

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

/** Every device of a project in one list, with no plan open: filter, sort, group, bulk edit, open on plan, details drawer, Excel. */
export function DevicesPage({ user }: { user: User }) {
  void user
  const { projectId } = useParams()
  const pid = projectId!
  const navigate = useNavigate()
  const isPhone = useMediaQuery('(max-width: 640px)')
  const { catalog } = useCatalog()
  const [project, setProject] = useState<Project | null>(null)
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [markups, setMarkups] = useState<Markup[] | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState<DeviceFilter>(NO_DEVICE_FILTER)
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'tag', dir: 'asc' })
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [sel, setSel] = useState<ListSel<string>>(emptySel())
  const [limit, setLimit] = useState(PAGE)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const docsRef = useRef<DocumentSummary[]>([])

  const role = project?.role
  const locked = lockedFor(role, { locked: project?.settings?.locked === true })
  const canFields = can(role, 'markup.fields') && !locked
  const limited = isFieldOnly(role)

  const reload = useCallback(async () => {
    setError('')
    try {
      const ds = (await loadDocuments(pid)).data
      docsRef.current = ds
      setDocs(ds)
      const r = await loadProjectDevices(pid, ds.map(d => d.id))
      setMarkups(r.markups)
      setFromCache(r.fromCache)
    } catch (e) { setError((e as Error).message); setMarkups(m => m ?? []) }
  }, [pid])

  useEffect(() => {
    loadProject(pid).then(r => setProject(r.data)).catch(e => setError(e.message))
    loadSymbolSets().then(r => setSets(r.data)).catch(() => {})
    void reload()
  }, [pid, reload])

  const setMap = useMemo(() => new Map(sets.map(s => [s.id, s])), [sets])
  const setList = useMemo(() => [...sets].sort((a, b) => a.sort - b.sort), [sets])

  // Rooms are computed here, per plan, from the area markups with the same code the plan list uses (areas need their parent chain, so
  // the server returns raw areas and devices rather than a precomputed room name).
  const allRows = useMemo(
    () => buildRows(markups ?? [], { symbolSets: setMap, catalog, docNames: new Map(docs.map(d => [d.id, d.name])) }).filter(r => r.isDevice),
    [markups, setMap, catalog, docs])
  const plans = useMemo(() => planOptions(allRows), [allRows])
  const areas = useMemo(() => areaOptions(filter.planId ? allRows.filter(r => r.documentId === filter.planId) : allRows), [allRows, filter.planId])
  const rows = useMemo(() => sortDevices(filterDevices(allRows, filter), sort.col, sort.dir), [allRows, filter, sort])
  const groups = useMemo(() => groupDevices(rows.slice(0, limit), groupBy), [rows, limit, groupBy])
  const order = useMemo(() => displayOrder(groups), [groups])
  useEffect(() => setLimit(PAGE), [filter, sort, groupBy])
  // Selection never keeps rows that a filter hid
  useEffect(() => {
    const visible = new Set(rows.map(r => r.id))
    setSel(s => (s.selected.every(id => visible.has(id)) ? s : { selected: s.selected.filter(id => visible.has(id)), anchor: s.anchor && visible.has(s.anchor) ? s.anchor : null }))
  }, [rows])

  const byId = useMemo(() => new Map((markups ?? []).map(m => [m.id, m])), [markups])
  const selectedMarkups = useMemo(() => sel.selected.map(id => byId.get(id)).filter((m): m is Markup => !!m), [sel, byId])

  /** Edits go through the offline outbox, exactly like edits made on the plan, so they work without a connection. */
  const applyChanges = useCallback(async (changed: Markup[]) => {
    if (!changed.length) return
    const next = new Map(changed.map(m => [m.id, m]))
    setMarkups(cur => (cur ?? []).map(m => next.get(m.id) ?? m))
    await Promise.all(changed.map(m => queueMarkupPut(m.document_id, m)))
  }, [])

  const runBulk = async (res: BulkResult, what: string, extra = '') => {
    setNotice('')
    try {
      await applyChanges(res.changed)
      setNotice((res.changed.length ? `${what}: ${res.changed.length} device${res.changed.length === 1 ? '' : 's'} updated${res.skipped ? `, ${res.skipped} unchanged` : ''}.` : res.skipped ? `${what}: nothing to change.` : '') + (extra ? ` ${extra}` : ''))
    } catch (e) { setError((e as Error).message) }
  }

  const sortBy = (col: string) => setSort(s => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }))
  const anchor = useRef<string | null>(null)
  anchor.current = sel.anchor
  const pick = (e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }, id: string) => {
    setSel(s => clickSelect(order, s, id, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }))
    clearTextSelection()
  }
  const toggle = (id: string) => setSel(s => clickSelect(order, s, id, { ctrl: true }))
  const allOn = order.length > 0 && order.every(id => sel.selected.includes(id))

  const openOnPlan = (r: ScheduleRow) => navigate(`/projects/${pid}/documents/${r.documentId}?markup=${r.id}&page=${r.page}`)

  async function exportExcel() {
    setBusy(true); setError('')
    try {
      const { downloadWorkbook } = await import('../schedule/xlsxIO')
      const tables = exportTables(rows, setList).filter(t => t.name !== 'Measurements')
      await downloadWorkbook(tables, exportFileName(project?.name ?? 'Project'))
    } catch (e) { setError(`Export failed: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  const drawerRow = drawerId ? allRows.find(r => r.id === drawerId) : undefined
  const drawerMarkup = drawerId ? byId.get(drawerId) : undefined
  const filterActive = JSON.stringify(filter) !== JSON.stringify(NO_DEVICE_FILTER)

  const filterControls = (
    <>
      <input type="search" className="dv-search" placeholder="Search tag, IP, product, room…" aria-label="Search devices"
        value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })} />
      <select aria-label="Filter by plan" value={filter.planId} onChange={e => setFilter({ ...filter, planId: e.target.value, area: '' })}>
        <option value="">All plans</option>
        {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select aria-label="Filter by symbol set" value={filter.setId} onChange={e => setFilter({ ...filter, setId: e.target.value })}>
        <option value="">All sets</option>
        {setList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <select aria-label="Filter by status" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
        <option value="">Any status</option>
        {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <select aria-label="Filter by room" value={filter.area} onChange={e => setFilter({ ...filter, area: e.target.value })}>
        <option value="">All rooms</option>
        {areas.map(a => <option key={a} value={a}>{a}</option>)}
      </select>
      <select aria-label="Group by" value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)}>
        {GROUP_OPTIONS.map(g => <option key={g.value} value={g.value}>{g.value === 'none' ? 'No grouping' : `Group by ${g.label.toLowerCase()}`}</option>)}
      </select>
      {filterActive && <button className="small" onClick={() => setFilter(NO_DEVICE_FILTER)}>Clear filters</button>}
    </>
  )

  return (
    <RoleContext.Provider value={role ?? null}>
    <CatalogContext.Provider value={catalog}>
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <span className="muted">/</span>
        <Link to={`/projects/${pid}`} className="crumb">{project?.name ?? '…'}</Link>
        <span className="muted">/</span>
        <span className="crumb">Devices</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content dv-content">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={false} className="tab" onClick={() => navigate(`/projects/${pid}`)}>Plans</button>
          <button role="tab" aria-selected className="tab active">Devices</button>
          <button role="tab" aria-selected={false} className="tab" onClick={() => navigate(`/projects/${pid}/wiring`)}>Wiring</button>
        </div>
        <div className="dv-bar">
          {isPhone ? (
            <>
              <input type="search" className="dv-search" placeholder="Search devices" aria-label="Search devices"
                value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })} />
              <button onClick={() => setFiltersOpen(true)}>Filters{filterActive ? ' •' : ''}</button>
            </>
          ) : filterControls}
          <span className="spacer" />
          <span className="muted small" aria-live="polite">{rows.length} of {allRows.length} device{allRows.length === 1 ? '' : 's'}</span>
          <button onClick={() => void reload()} disabled={busy}>Refresh</button>
          <button onClick={exportExcel} disabled={busy || rows.length === 0}>{busy ? 'Exporting…' : 'Export Excel'}</button>
        </div>
        {fromCache && <div className="muted small" role="status">Showing the copy saved on this device. Changes you make are kept and sent when you are back online.</div>}
        {locked && <div className="lock-banner" role="status">This project is locked. Only admins can make changes.</div>}
        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="muted small" role="status">{notice}</div>}

        {canFields && sel.selected.length > 0 && (
          <BulkBar count={sel.selected.length} selected={selectedMarkups} sets={setMap}
            onStatus={s => {
              // Required fields per status (project settings): devices missing something keep their status.
              const defsOf = (m: Markup) => fieldDefsFor(m.symbol_set_id ? setMap.get(m.symbol_set_id) : undefined, m.device_type_id ? catalog.types.get(m.device_type_id) : undefined)
              const { allowed, blocked } = gateStatus(selectedMarkups, s, defsOf)
              void runBulk(bulkStatus(allowed, s), 'Status', describeBlocked(s, blocked))
            }}
            onField={(f, v) => runBulk(bulkField(selectedMarkups, f.key, v, f.type), f.label)}
            onClear={() => setSel(emptySel())} />
        )}

        {markups === null ? <p className="muted">Loading…</p> : rows.length === 0 ? (
          <p className="muted">{allRows.length === 0 ? (error ? '' : 'No devices have been placed in this project yet.') : 'No devices match the filters.'}</p>
        ) : isPhone ? (
          <div className="dv-cards" onKeyDown={e => {
            if ((e.target as HTMLElement).closest('input,textarea,select')) return
            const res = keySelect(order, sel, e); if (res) { e.preventDefault(); setSel(res) }
          }}>
            {groups.map(g => (
              <section key={g.key || 'all'}>
                {groupBy !== 'none' && <h3 className="dv-group">{g.label} <span className="muted small">{g.rows.length}</span></h3>}
                {g.rows.map(r => (
                  <article key={r.id} className={`dv-card${sel.selected.includes(r.id) ? ' sel' : ''}`}>
                    <div className="dv-card-head">
                      {canFields && <input type="checkbox" aria-label={`Select ${r.tag || 'device'}`} checked={sel.selected.includes(r.id)} onChange={() => toggle(r.id)} />}
                      <strong>{r.tag || '—'}</strong>
                      <StatusPill status={r.status} />
                      <span className="spacer" />
                      {r.photos > 0 && <span className="chip" title="Photos">{r.photos} photo{r.photos === 1 ? '' : 's'}</span>}
                    </div>
                    <div className="small">{deviceCell(r, 'set') || '—'}{r.productName && <span className="muted"> · {r.productName}</span>}</div>
                    <div className="muted small">{r.documentName} · page {r.page}{r.areaText && ` · ${r.areaText}`}</div>
                    {(r.fields.ip || r.fields.mac || r.fields.serial) && (
                      <div className="muted small mono">{[r.fields.ip, r.fields.mac, r.fields.serial].filter(Boolean).join(' · ')}</div>
                    )}
                    <div className="dv-actions">
                      <button onClick={() => openOnPlan(r)}>Open on plan</button>
                      <button onClick={() => setDrawerId(r.id)}>Details</button>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="table-scroll dv-scroll" tabIndex={-1} onKeyDown={e => {
            if ((e.target as HTMLElement).closest('input,textarea,select')) return
            const res = keySelect(order, sel, e); if (res) { e.preventDefault(); setSel(res) }
          }}>
            <table className="list-table dv-table">
              <thead>
                <tr>
                  <th className="dv-check">{canFields && <input type="checkbox" aria-label="Select all shown" checked={allOn} onChange={() => setSel(allOn ? emptySel() : selectAll(order))} />}</th>
                  {DEVICE_COLUMNS.map(c => (
                    <th key={c.id} aria-sort={sort.col === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button className="th-btn" onClick={() => sortBy(c.id)}>{c.label}{sort.col === c.id && <span aria-hidden> {sort.dir === 'asc' ? '▲' : '▼'}</span>}</button>
                    </th>
                  ))}
                  <th><span className="th-btn">Actions</span></th>
                </tr>
              </thead>
              {groups.map(g => (
                <tbody key={g.key || 'all'}>
                  {groupBy !== 'none' && (
                    <tr className="dv-group-row"><th colSpan={DEVICE_COLUMNS.length + 2}>{g.label} <span className="muted small">{g.rows.length}</span></th></tr>
                  )}
                  {g.rows.map(r => (
                    <tr key={r.id} className={sel.selected.includes(r.id) ? 'sel' : undefined} onClick={e => pick(e, r.id)}
                      onMouseDown={e => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault() }}>
                      <td className="dv-check" onClick={e => e.stopPropagation()}>
                        {canFields && <input type="checkbox" aria-label={`Select ${r.tag || 'device'}`} checked={sel.selected.includes(r.id)} onChange={() => toggle(r.id)} />}
                      </td>
                      {DEVICE_COLUMNS.map(c => (
                        <td key={c.id} className={c.id === 'tag' ? 'cell-tag' : c.id === 'ip' || c.id === 'mac' ? 'mono' : undefined}>
                          {c.id === 'status' ? <StatusPill status={r.status} />
                            : c.id === 'set' ? <><span className="dot" style={{ background: setMap.get(r.setId)?.color ?? '#868e96' }} />{deviceCell(r, c.id)}</>
                            : deviceCell(r, c.id)}
                        </td>
                      ))}
                      <td className="dv-actions-cell" onClick={e => e.stopPropagation()}>
                        <button className="small" onClick={() => openOnPlan(r)} title="Open this plan and zoom to the device">Open on plan</button>
                        <button className="small" onClick={() => setDrawerId(r.id)} title="Properties and photos without opening the plan">Details</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}
        {rows.length > limit && (
          <div className="list-more"><button onClick={() => setLimit(l => l + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}</button></div>
        )}
      </main>

      {filtersOpen && (
        <div className="dv-sheet-wrap" role="presentation" onClick={() => setFiltersOpen(false)}>
          <div className="dv-sheet" role="dialog" aria-label="Filters" onClick={e => e.stopPropagation()}>
            <div className="row"><strong>Filters</strong><span className="spacer" /><button onClick={() => setFiltersOpen(false)}>Done</button></div>
            <div className="dv-sheet-body">{filterControls}</div>
          </div>
        </div>
      )}

      {drawerId && (
        <aside className={`dv-drawer${isPhone ? ' phone' : ''}`} role="dialog" aria-label="Device details">
          <div className="row dv-drawer-head">
            <strong>{drawerRow?.tag || 'Device'}</strong>
            <span className="muted small">{drawerRow ? `${drawerRow.documentName} · page ${drawerRow.page}` : ''}</span>
            <span className="spacer" />
            {drawerRow && <button className="small" onClick={() => openOnPlan(drawerRow)}>Open on plan</button>}
            <button className="icon-btn" onClick={() => setDrawerId(null)} aria-label="Close details" title="Close">✕</button>
          </div>
          <div className="dv-drawer-body">
            {drawerMarkup ? (
              <DeviceFields devices={[drawerMarkup]} set={drawerMarkup.symbol_set_id ? setMap.get(drawerMarkup.symbol_set_id) : undefined}
                readOnly={!canFields} limited={limited} areaPath={drawerRow?.areaPath}
                onUpdate={patch => {
                  const cur = byId.get(drawerMarkup.id)
                  if (!cur) return
                  const next = patch(cur)
                  if (next !== cur) void applyChanges([next]).catch(e => setError((e as Error).message))
                }} />
            ) : <p className="muted">This device is no longer in the list.</p>}
          </div>
        </aside>
      )}
    </div>
    </CatalogContext.Provider>
    </RoleContext.Provider>
  )
}

function StatusPill({ status }: { status: string }) {
  const s = STATUSES.find(x => x.value === status)
  return s ? <span className="pill" style={{ background: s.color }}>{s.label}</span> : null
}

/** Fields that can be bulk-set: the selected devices' symbol set fields plus the hardware ones and notes. */
function bulkFieldDefs(selected: Markup[], sets: Map<string, SymbolSet>): FieldDef[] {
  const defs: FieldDef[] = []
  const seen = new Set<string>()
  const add = (f: FieldDef) => { if (!seen.has(f.key)) { seen.add(f.key); defs.push(f) } }
  for (const id of new Set(selected.map(m => m.symbol_set_id).filter((x): x is string => !!x))) sets.get(id)?.fields.forEach(add)
  HARDWARE_FIELDS.forEach(add)
  add(NOTES)
  return defs
}

function BulkBar({ count, selected, sets, onStatus, onField, onClear }: {
  count: number; selected: Markup[]; sets: Map<string, SymbolSet>
  onStatus: (s: Status) => void; onField: (f: FieldDef, v: string | number | boolean) => void; onClear: () => void
}) {
  const defs = useMemo(() => bulkFieldDefs(selected, sets), [selected, sets])
  const [status, setStatus] = useState<string>('installed')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const def = defs.find(d => d.key === key)
  const unique = !!def && count > 1 && isUniqueFieldKey(def.key, def.type)
  const parsed = (): string | number | boolean => {
    if (def?.type === 'checkbox') return value === 'yes'
    if (def?.type === 'number' && value.trim() !== '' && !isNaN(+value)) return +value
    return value
  }
  return (
    <div className="dv-bulk" role="region" aria-label="Bulk edit">
      <strong>{count} selected</strong>
      <label className="dv-bulk-group">Status
        <select aria-label="New status" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Clear status</option>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button onClick={() => onStatus(status as Status)}>Set status</button>
      </label>
      <label className="dv-bulk-group">Field
        <select aria-label="Field to set" value={key} onChange={e => { setKey(e.target.value); setValue('') }}>
          <option value="">Choose field…</option>
          {defs.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        {def?.type === 'select' ? (
          <select aria-label="Value" value={value} onChange={e => setValue(e.target.value)}>
            <option value="">—</option>
            {(def.options ?? []).map(o => <option key={o}>{o}</option>)}
          </select>
        ) : def?.type === 'checkbox' ? (
          <select aria-label="Value" value={value} onChange={e => setValue(e.target.value)}>
            <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
          </select>
        ) : (
          <input aria-label="Value" type={def?.type === 'date' ? 'date' : 'text'} value={value} onChange={e => setValue(e.target.value)} disabled={!def} placeholder="Value" />
        )}
        <button disabled={!def || unique || (def.type === 'checkbox' && !value)} onClick={() => def && onField(def, parsed())}>Apply</button>
      </label>
      {unique && <span className="muted small">IP, MAC and serial identify one unit, so they cannot be set on several devices at once.</span>}
      <span className="spacer" />
      <button onClick={onClear}>Clear selection</button>
    </div>
  )
}
