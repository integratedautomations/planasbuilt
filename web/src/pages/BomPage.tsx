import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import type { DocumentSummary, Project, User } from '../api'
import { computeBom, hours, money } from '../catalog/bom'
import type { BomDevice, BomSection } from '../catalog/bom'
import { bomFileName, downloadBomExcel, downloadBomPdf } from '../catalog/bomExport'
import { useCatalog } from '../catalog/useCatalog'
import { cableSettings, cableTotals } from '../markups/cables'
import type { Markup, SymbolSet } from '../markups/types'
import { OfflineBanner } from '../offline/OfflineBanner'
import { db } from '../offline/db'
import { loadDocuments, loadProject, loadSymbolSets } from '../offline/cache'
import { areaOptions, buildRows } from '../schedule/rows'
import { Brand } from '../Brand'
import { CompanySwitcher } from '../company/CompanySwitcher'
import { UserMenu } from '../settings/UserMenu'

const SECTION_TITLE: Record<BomSection, string> = { devices: 'Devices', accessories: 'Accessories', unassigned: 'Unassigned devices (no product chosen)' }

/** Project bill of materials: quantities, cost and labor, filterable by plan and area, exported to Excel and PDF. */
export function BomPage({ user }: { user: User }) {
  void user
  const { projectId } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [markups, setMarkups] = useState<Markup[]>([])
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [scaleRows, setScaleRows] = useState<{ document_id: string; page: number; points_per_foot: number }[]>([])
  const [docFilter, setDocFilter] = useState('')
  const [area, setArea] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const { catalog } = useCatalog()
  /** Roles that may not see costs get quantities only. */
  const costs = catalog.canSeeCosts

  useEffect(() => {
    loadProject(projectId!).then(r => setProject(r.data)).catch(e => setError(e.message))
    loadSymbolSets().then(r => setSets(r.data)).catch(() => {})
    api<{ document_id: string; page: number; points_per_foot: number }[]>(`/projects/${projectId}/scales`).then(setScaleRows).catch(() => {})
    loadDocuments(projectId!).then(async r => {
      setDocs(r.data)
      try {
        setMarkups(await api<Markup[]>(`/projects/${projectId}/markups`))
      } catch {
        // offline: use what is saved on this device
        const local = await db.markups.where('document_id').anyOf(r.data.map(d => d.id)).toArray()
        setMarkups(local.filter(m => !(m as { deleted?: boolean }).deleted))
      }
    }).catch(e => setError(e.message))
  }, [projectId])

  const setMap = useMemo(() => new Map(sets.map(s => [s.id, s])), [sets])
  const rows = useMemo(() => buildRows(markups, { symbolSets: setMap, catalog, docNames: new Map(docs.map(d => [d.id, d.name])) }).filter(r => r.isDevice), [markups, setMap, catalog, docs])
  const devices = useMemo<BomDevice[]>(() => rows.map(r => ({
    setId: r.setId, typeId: r.typeId || null, productId: r.productId || null, documentId: r.documentId, areaPath: r.areaPath,
  })), [rows])
  const areas = useMemo(() => areaOptions(docFilter ? rows.filter(r => r.documentId === docFilter) : rows), [rows, docFilter])
  const bom = useMemo(() => computeBom(devices, catalog, setMap, { documentId: docFilter || undefined, area: area || undefined }), [devices, catalog, setMap, docFilter, area])
  const cables = useMemo(() => {
    const ppf = new Map(scaleRows.map(s => [`${s.document_id}:${s.page}`, s.points_per_foot]))
    const list = docFilter ? markups.filter(m => m.document_id === docFilter) : markups
    return cableTotals(list, (d, p) => ppf.get(`${d}:${p}`) ?? null, catalog.cableTypes, cableSettings(project))
  }, [markups, scaleRows, docFilter, catalog, project])
  const scope = [docFilter ? docs.find(d => d.id === docFilter)?.name : 'All plans', area || 'all areas'].join(', ')
  const deviceCount = devices.filter(d => (!docFilter || d.documentId === docFilter)).length

  async function exportAs(kind: 'xlsx' | 'pdf') {
    if (!project) return
    setBusy(kind); setError('')
    try {
      if (kind === 'xlsx') await downloadBomExcel(bom, bomFileName(project.name, 'xlsx'), costs, cables)
      else await downloadBomPdf(bom, { projectName: project.name, scope, date: new Date(), costs, cables }, bomFileName(project.name, 'pdf'))
    } catch (e) { setError(`Export failed: ${(e as Error).message}`) } finally { setBusy('') }
  }

  const grouped = (['devices', 'accessories', 'unassigned'] as BomSection[]).map(s => ({ s, lines: bom.lines.filter(l => l.section === s) })).filter(g => g.lines.length)
  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <CompanySwitcher />
        <span className="muted">/</span>
        <Link to={`/projects/${projectId}`} className="crumb">{project?.name ?? '…'}</Link>
        <span className="muted">/</span>
        <span className="crumb">BOM</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content">
        <div className="row wrap">
          <h2>Bill of materials</h2>
          <span className="spacer" />
          <label className="field inline">Plan
            <select value={docFilter} onChange={e => { setDocFilter(e.target.value); setArea('') }}>
              <option value="">All plans</option>
              {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="field inline">Area
            <select value={area} onChange={e => setArea(e.target.value)}>
              <option value="">All areas</option>
              {areas.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <button disabled={!!busy || bom.lines.length === 0} onClick={() => exportAs('xlsx')}>{busy === 'xlsx' ? 'Exporting…' : 'Export Excel'}</button>
          <button disabled={!!busy || bom.lines.length === 0} onClick={() => exportAs('pdf')}>{busy === 'pdf' ? 'Building…' : 'Export PDF'}</button>
        </div>
        {error && <div className="error">{error}</div>}
        <p className="muted small">{deviceCount} placed device{deviceCount === 1 ? '' : 's'} in scope. Each device in a stack counts. Accessories are multiplied by device count and merged by product.</p>
        {cables.length > 0 && (
          <div className="table-scroll">
            <h3>Cables</h3>
            <table className="bom-table">
              <thead><tr><th>Cable type</th><th className="num">Cables</th><th className="num">Runs</th><th className="num">Length</th></tr></thead>
              <tbody>
                {cables.map(c => (
                  <tr key={c.typeId || 'none'}>
                    <td><span className="dot" style={{ background: c.color }} /> {c.name}</td>
                    <td className="num">{c.cables}</td><td className="num">{c.runs}</td>
                    <td className="num">{(Math.round(c.lengthFt * 10) / 10).toLocaleString('en-US')} ft{c.unscaled > 0 && <span className="muted small"> (+{c.unscaled} on pages without a scale)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Length = drawn x (1 + slack) + drop x linked ends, times runs. Slack and drop come from the project's cable defaults unless a cable overrides them.</p>
          </div>
        )}
        {bom.lines.length === 0 ? <p className="muted">No devices to list.</p> : (
          <div className="table-scroll">
            <table className="bom-table">
              <thead>
                <tr><th>Item</th><th className="num">Qty</th>{costs && <><th className="num">Unit cost</th><th className="num">Ext cost</th><th className="num">Labor hrs</th><th className="num">Ext labor</th></>}</tr>
              </thead>
              <tbody>
                {grouped.map(g => (
                  <SectionRows key={g.s} title={SECTION_TITLE[g.s]} lines={g.lines} unassigned={g.s === 'unassigned'} costs={costs} />
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td className="num">{bom.totals.qty}</td>{costs && <><td /><td className="num">{money(bom.totals.cost)}</td><td /><td className="num">{hours(bom.totals.labor)}</td></>}</tr>
              </tfoot>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}

function SectionRows({ title, lines, unassigned, costs }: { title: string; lines: ReturnType<typeof computeBom>['lines']; unassigned: boolean; costs: boolean }) {
  return (
    <>
      <tr className="section-row"><td colSpan={costs ? 6 : 2}>{title}</td></tr>
      {lines.map(l => (
        <tr key={l.key}>
          <td>
            {[l.manufacturer, l.model].filter(Boolean).join(' ') || l.name}
            {(l.manufacturer || l.model) && l.name && l.name !== l.model && <span className="muted"> {'·'} {l.name}</span>}
            {l.accessoryQty > 0 && l.section !== 'accessories' && <span className="chip" title="Includes accessory quantity">+{l.accessoryQty} as accessory</span>}
            {l.group && <div className="muted small">{l.group}</div>}
          </td>
          <td className="num">{l.qty}</td>
          {costs && <>
            <td className="num">{unassigned ? '' : money(l.unitCost)}</td>
            <td className="num">{unassigned ? '' : money(l.extCost)}</td>
            <td className="num">{unassigned ? '' : hours(l.laborHours)}</td>
            <td className="num">{unassigned ? '' : hours(l.extLabor)}</td>
          </>}
        </tr>
      ))}
    </>
  )
}
