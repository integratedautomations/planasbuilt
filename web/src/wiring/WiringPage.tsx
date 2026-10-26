import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import type { DocumentSummary, Project, User } from '../api'
import { CatalogContext, useCatalog } from '../catalog/useCatalog'
import { cableSettings } from '../markups/cables'
import type { Markup, SymbolSet } from '../markups/types'
import { loadDocuments, loadProject, loadSymbolSets } from '../offline/cache'
import { downloadBytes } from '../pdfio/download'
import { loadIcons } from '../pdfio/icons'
import { NOT_CONNECTED_TEXT, problemText } from './graph'
import { loadProjectWiring } from './loadWiring'
import { ProjectBody } from '../shell/ProjectShell'
import { RiserSvg } from './RiserSvg'
import { loadCompany } from '../settings/company'
import { buildRiserPdf, riserFileName, riserPages, wiringOf } from './riserPdf'
import type { RiserInput } from './riserPdf'
import '../devices/devices.css'
import './wiring.css'

interface ScaleRow { document_id: string; page: number; points_per_foot: number }

/** Riser diagram built from the cable runs locked to devices: a column per hub, devices as rows, plus a Not connected QA list. */
export function WiringPage({ user }: { user: User }) {
  void user
  const { projectId } = useParams()
  const pid = projectId!
  const navigate = useNavigate()
  const { catalog } = useCatalog()
  const [project, setProject] = useState<Project | null>(null)
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [markups, setMarkups] = useState<Markup[] | null>(null)
  const [scales, setScales] = useState<ScaleRow[]>([])
  const [fromCache, setFromCache] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setError('')
    try {
      const ds = (await loadDocuments(pid)).data
      setDocs(ds)
      const r = await loadProjectWiring(pid, ds.map(d => d.id))
      setMarkups(r.markups)
      setFromCache(r.fromCache)
    } catch (e) { setError((e as Error).message); setMarkups(m => m ?? []) }
  }, [pid])

  useEffect(() => {
    loadProject(pid).then(r => setProject(r.data)).catch(e => setError(e.message))
    loadSymbolSets().then(r => setSets(r.data)).catch(() => {})
    api<ScaleRow[]>(`/projects/${pid}/scales`).then(setScales).catch(() => {})
    void reload()
  }, [pid, reload])

  const input = useMemo<RiserInput | null>(() => {
    if (!markups) return null
    const ppf = new Map(scales.map(s => [`${s.document_id}:${s.page}`, s.points_per_foot]))
    return {
      projectName: project?.name ?? 'Project', date: new Date(), markups, symbolSets: new Map(sets.map(s => [s.id, s])), catalog,
      docNames: new Map(docs.map(d => [d.id, d.name])), scaleFor: (d, p) => ppf.get(`${d}:${p}`) ?? null, defaults: cableSettings(project),
    }
  }, [markups, scales, project, sets, catalog, docs])
  const wiring = useMemo(() => (input ? wiringOf(input) : null), [input])
  const pages = useMemo(() => (input ? riserPages(input, false) : []), [input])
  const setMap = useMemo(() => new Map(sets.map(s => [s.id, s])), [sets])
  const docName = (id: string) => docs.find(d => d.id === id)?.name ?? ''

  const openOnPlan = useCallback((id: string) => {
    const m = markups?.find(x => x.id === id)
    if (m) navigate(`/projects/${pid}/documents/${m.document_id}?markup=${m.id}&page=${m.page}`)
  }, [markups, navigate, pid])

  async function exportPdf() {
    if (!input) return
    setBusy(true); setError('')
    try {
      const icons = await loadIcons(sets, [...catalog.types.values()])
      const company = (await loadCompany().catch(() => null))?.name
      downloadBytes(await buildRiserPdf({ ...input, icons, date: new Date(), company }), riserFileName(input.projectName))
    } catch (e) { setError(`Export failed: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  return (
    <CatalogContext.Provider value={catalog}>
      <ProjectBody width="full">
          <div className="row wrap">
            <h2>Wiring riser</h2>
            <span className="spacer" />
            <button disabled={busy || !wiring || (!wiring.hubs.length && !wiring.notConnected.devices.length)} onClick={() => void exportPdf()}>{busy ? 'Building…' : 'Export PDF'}</button>
          </div>
          {error && <div className="error">{error}</div>}
          {fromCache && <p className="muted small">Offline: showing what is saved on this device.</p>}
          {!markups && !error && <p className="muted">Loading…</p>}
          {wiring && (
            <p className="muted small">
              {wiring.counts.devices} device{wiring.counts.devices === 1 ? '' : 's'}, {wiring.counts.hubs} hub{wiring.counts.hubs === 1 ? '' : 's'}, {wiring.counts.cables} cable run{wiring.counts.cables === 1 ? '' : 's'}.
              Hubs are panels, controllers, switches, recorders, power supplies and racks.{wiring.hubs.length > 0 && ' Click a device to open it on its plan.'}
            </p>
          )}
          {wiring && wiring.hubs.length === 0 && (
            <div className="wiring-empty" role="status">
              <strong>{wiring.counts.cables > 0 ? 'No riser to show yet' : 'No cable runs yet'}</strong>
              <span className="muted">
                {wiring.counts.cables > 0
                  ? `${wiring.counts.cables} cable run${wiring.counts.cables === 1 ? '' : 's'} drawn, but none connect to a panel or switch. Connect a run to a hub (panel, controller, switch, recorder or power supply) and it appears here.`
                  : 'Draw cable runs with the Cable tool. Ends that snap to a device centre lock to that device.'}
              </span>
            </div>
          )}
          <div className="wiring-pages">
            {wiring && wiring.hubs.length > 0 && pages.map((p, i) => <RiserSvg key={i} page={p} catalog={catalog} symbolSets={setMap} onDevice={openOnPlan} />)}
          </div>
          {wiring && (wiring.notConnected.devices.length > 0 || wiring.notConnected.cables.length > 0) && (
            <section className="wiring-qa" aria-label="Not connected">
              <h3>Not connected</h3>
              {wiring.notConnected.devices.length > 0 && (
                <div className="table-scroll">
                  <table className="bom-table">
                    <thead><tr><th>Device</th><th>Type</th><th>Plan</th><th>Why</th></tr></thead>
                    <tbody>
                      {wiring.notConnected.devices.map(d => (
                        <tr key={d.node.id}>
                          <td><button className="link-btn" onClick={() => openOnPlan(d.node.id)}>{d.node.tag || '(no tag)'}</button></td>
                          <td>{d.node.typeName}</td><td>{docName(d.node.documentId)} p{d.node.page}</td><td className="muted">{NOT_CONNECTED_TEXT[d.reason]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {wiring.notConnected.cables.length > 0 && (
                <div className="table-scroll">
                  <h4>Cable runs with a problem</h4>
                  <table className="bom-table">
                    <thead><tr><th>Cable</th><th>Linked to</th><th>Plan</th><th>Problem</th></tr></thead>
                    <tbody>
                      {wiring.notConnected.cables.map(c => (
                        <tr key={c.cableId}>
                          <td><button className="link-btn" onClick={() => openOnPlan(c.cableId)}>{c.typeName || 'Cable'}</button></td>
                          <td>{c.tags.join(', ') || '-'}</td><td>{c.documentName} p{c.page}</td><td className="muted">{problemText(c)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
      </ProjectBody>
    </CatalogContext.Provider>
  )
}
