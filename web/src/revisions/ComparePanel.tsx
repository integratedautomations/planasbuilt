import { useEffect, useMemo, useState } from 'react'
import type { DocumentRevision } from '../api'
import { loadPdf } from '../pdf'
import type { PDFDocumentProxy } from '../pdf'
import { fetchRevisionPdf, loadRevision, revisionName } from './api'
import type { RevisionDetail } from './api'
import { changeEntries, diffIsEmpty, diffMarkups, groupByPage, KIND_LABELS } from './diff'
import type { ChangeEntry, ChangeKind } from './diff'
import { diffPixels, rectsToPage } from './pixelDiff'
import type { CloudInput } from './clouds'
import type { CompareMode } from './CompareView'

export interface CompareRequest { a: RevisionDetail; b: RevisionDetail; mode: CompareMode; page: number; focus?: { page: number; x: number; y: number } }

interface Props {
  documentId: string
  revisions: DocumentRevision[]
  /** Revision pair to start from (e.g. from the project page); defaults to previous vs newest. */
  initial?: { a: string; b: string } | null
  canEdit: boolean
  currentPage: number
  /** Go to a spot in the plan shown in the viewer. */
  onJump: (page: number, x: number, y: number) => void
  onOpen: (req: CompareRequest) => void
  /** Adds revision clouds to the live plan on a new "Rev N changes" layer, as one undo step. */
  onClouds: (inputs: CloudInput[], layerName: string) => Promise<void>
}

const KIND_ORDER: ChangeKind[] = ['added', 'removed', 'moved', 'resized', 'fields', 'status', 'style']

const PIXEL_WIDTH = 900

/** Renders both revisions' page at the same small size and returns the changed regions in page points. */
async function pixelChanges(a: PDFDocumentProxy, b: PDFDocumentProxy, onPage: (p: number, n: number) => void): Promise<CloudInput[]> {
  const out: CloudInput[] = []
  const n = Math.min(a.numPages, b.numPages)
  const render = async (pdf: PDFDocumentProxy, pageNum: number, width: number, height: number) => {
    const page = await pdf.getPage(pageNum)
    const vp1 = page.getViewport({ scale: 1 })
    const vp = page.getViewport({ scale: width / vp1.width })
    const c = document.createElement('canvas')
    c.width = width; c.height = height
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height)
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise
    return ctx.getImageData(0, 0, width, height)
  }
  for (let p = 1; p <= n; p++) {
    onPage(p, n)
    const base = (await a.getPage(p)).getViewport({ scale: 1 })
    const width = PIXEL_WIDTH, scale = width / base.width, height = Math.max(1, Math.round(base.height * scale))
    const [ia, ib] = [await render(a, p, width, height), await render(b, p, width, height)]
    for (const r of rectsToPage(diffPixels(ia, ib, { cell: 8, gap: 2 }), scale)) out.push({ page: p, rect: r })
  }
  return out
}

/** Dockable "Compare" panel: pick two revisions, see what changed, jump to it, open a visual compare or add clouds. */
export function ComparePanel({ documentId, revisions, initial, canEdit, currentPage, onJump, onOpen, onClouds }: Props) {
  const newest = revisions[0]
  const [aId, setAId] = useState(initial?.a ?? revisions[1]?.id ?? '')
  const [bId, setBId] = useState(initial?.b ?? newest?.id ?? '')
  const [a, setA] = useState<RevisionDetail | null>(null)
  const [b, setB] = useState<RevisionDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [pixels, setPixels] = useState(false)
  const [note, setNote] = useState('')

  // Defaults follow the revision list as it loads or grows.
  useEffect(() => {
    if (!aId && revisions[1]) setAId(revisions[1].id)
    if (!bId && revisions[0]) setBId(revisions[0].id)
  }, [revisions]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!aId) { setA(null); return }
    let cancelled = false
    setError('')
    loadRevision(documentId, aId).then(d => { if (!cancelled) setA(d) }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [documentId, aId, revisions])
  useEffect(() => {
    if (!bId) { setB(null); return }
    let cancelled = false
    loadRevision(documentId, bId).then(d => { if (!cancelled) setB(d) }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [documentId, bId, revisions])

  // Always compare older to newer, whichever way round they were picked.
  const [older, newer] = useMemo(() => {
    if (!a || !b) return [null, null] as const
    return a.revision <= b.revision ? [a, b] as const : [b, a] as const
  }, [a, b])
  const diff = useMemo(() => (older && newer ? diffMarkups(older.markups, newer.markups) : null), [older, newer])
  const entries = useMemo(() => (diff ? changeEntries(diff) : []), [diff])
  const pages = useMemo(() => groupByPage(entries), [entries])
  const totals = useMemo(() => {
    const t: Record<ChangeKind, number> = { added: 0, removed: 0, moved: 0, resized: 0, fields: 0, status: 0, style: 0 }
    for (const e of entries) for (const k of e.kinds) t[k]++
    return t
  }, [entries])

  const label = (e: ChangeEntry) => {
    const m = (e.after ?? e.before)!
    return m.tag || (m.text ? `${m.type} “${m.text.slice(0, 20)}”` : m.type)
  }
  const detail = (e: ChangeEntry) => e.changes.slice(0, 3).map(c => `${c.key.replace('fields.', '')}: ${String(c.old ?? '') || '–'} → ${String(c.new ?? '') || '–'}`).join('; ')
  const centerOf = (e: ChangeEntry) => ({ x: e.rect.x + e.rect.width / 2, y: e.rect.y + e.rect.height / 2 })

  const open = (mode: CompareMode) => {
    if (!older || !newer) return
    onOpen({ a: older, b: newer, mode, page: pages.some(p => p.page === currentPage) || !pages.length ? currentPage : pages[0].page })
  }

  async function makeClouds() {
    if (!older || !newer || !entries.length && !pixels) return
    setBusy('Working…'); setError(''); setNote('')
    try {
      const inputs: CloudInput[] = entries.map(e => ({ page: e.page, rect: e.rect }))
      if (pixels) {
        const tasks: ReturnType<typeof loadPdf>[] = []
        try {
          const [ba, bb] = await Promise.all([fetchRevisionPdf(documentId, older.id), fetchRevisionPdf(documentId, newer.id)])
          const [pa, pb] = [loadPdf(ba), loadPdf(bb)]
          tasks.push(pa, pb)
          const [da, db] = await Promise.all([pa.promise, pb.promise])
          inputs.push(...await pixelChanges(da, db, (p, n) => setBusy(`Comparing page ${p} of ${n}…`)))
        } finally { tasks.forEach(t => t.destroy()) }
      }
      if (!inputs.length) { setNote('Nothing to cloud: no changes found.'); return }
      await onClouds(inputs, `Rev ${newer.revision} changes`)
      setNote(`Added clouds around ${inputs.length} change${inputs.length === 1 ? '' : 's'} (merged where close). Undo removes them in one step.`)
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  if (revisions.length < 2) {
    return (
      <div className="panel-body compare-panel">
        <div className="panel-heading">Compare revisions</div>
        <p className="muted small">This plan has only one revision. Upload a new PDF, change pages, or issue a revision to compare against later.</p>
      </div>
    )
  }

  const options = revisions.map(r => <option key={r.id} value={r.id}>{revisionName(r)}{r.id === newest.id ? ' (current)' : ''}</option>)
  const newestSelected = newer && newest && newer.id === newest.id

  return (
    <div className="panel-body compare-panel">
      <div className="panel-heading">Compare revisions</div>
      <label className="field-row small">Older
        <select value={aId} onChange={e => setAId(e.target.value)} aria-label="Older revision">{options}</select>
      </label>
      <label className="field-row small">Newer
        <select value={bId} onChange={e => setBId(e.target.value)} aria-label="Newer revision">{options}</select>
      </label>
      {error && <div className="error">{error}</div>}
      {!diff && !error && <p className="muted small">Loading…</p>}
      {older && newer && older.id === newer.id && <p className="muted small">Pick two different revisions.</p>}
      {diff && older && newer && older.id !== newer.id && (
        <>
          <p className="small" role="status">
            {diffIsEmpty(diff) ? 'No markup changes.' : KIND_ORDER.filter(k => totals[k]).map(k => `${totals[k]} ${KIND_LABELS[k].toLowerCase()}`).join(' · ')}
          </p>
          <div className="row wrap">
            <button onClick={() => open('side')} disabled={!!busy}>Side by side</button>
            <button onClick={() => open('overlay')} disabled={!!busy}>Overlay</button>
          </div>
          {canEdit && (
            <div className="compare-clouds">
              <button onClick={makeClouds} disabled={!!busy || !newestSelected || (!entries.length && !pixels)}
                title={newestSelected ? 'Draw revision clouds around every change on a new layer' : 'Clouds are added to the current plan: choose the current revision as the newer one'}>
                {busy || 'Cloud changes'}
              </button>
              <label className="check small"><input type="checkbox" checked={pixels} onChange={e => setPixels(e.target.checked)} /> Also cloud changes in the drawing itself</label>
            </div>
          )}
          {note && <p className="muted small" role="status">{note}</p>}
          <div className="change-groups">
            {pages.map(p => (
              <section key={p.page}>
                <h4>
                  <button className="link-btn" onClick={() => { const c = centerOf(p.entries[0]); onJump(p.page, c.x, c.y) }}>Page {p.page}</button>
                  <span className="muted small"> {KIND_ORDER.filter(k => p.counts[k]).map(k => `${p.counts[k]} ${KIND_LABELS[k].toLowerCase()}`).join(', ')}</span>
                </h4>
                <ul className="change-list">
                  {p.entries.map(e => (
                    <li key={e.id}>
                      <button onClick={() => { const c = centerOf(e); onJump(e.page, c.x, c.y) }} title="Show in the plan">
                        <span className="change-name">{label(e)}</span>
                        <span className="muted small">{e.kinds.map(k => KIND_LABELS[k]).join(', ')}</span>
                        {detail(e) && <span className="muted small change-detail">{detail(e)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
