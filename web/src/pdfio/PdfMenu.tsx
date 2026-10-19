import { useRef, useState } from 'react'
import { useCatalogContext } from '../catalog/useCatalog'
import type { PageScale } from '../markups/ScaleControl'
import type { Markup, SymbolSet } from '../markups/types'
import type { Change } from '../markups/useMarkups'
import { exportDocumentPdf, planImportFile } from './actions'
import type { ImportPlan } from './importPlan'

interface Props {
  documentId: string
  documentName: string
  markups: Map<string, Markup>
  symbolSets: Map<string, SymbolSet>
  scales: Map<number, PageScale>
  readOnly: boolean
  commit: (change: Change) => void
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** Viewer toolbar menu: annotated / flattened PDF export and import from an annotated PDF. */
export function PdfMenu({ documentId, documentName, markups, symbolSets, scales, readOnly, commit }: Props) {
  const catalog = useCatalogContext()
  const menu = useRef<HTMLDetailsElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<ImportPlan | null>(null)

  const close = () => { if (menu.current) menu.current.open = false }

  async function run(kind: 'annotated' | 'flattened') {
    close(); setNote(''); setBusy(kind === 'annotated' ? 'Exporting annotated PDF…' : 'Exporting flattened PDF…')
    try {
      await exportDocumentPdf(kind, {
        documentId, name: documentName, markups: markups.values(), symbolSets, deviceTypes: catalog.types.values(),
        scales: new Map([...scales].map(([p, s]) => [p, s.pointsPerFoot])),
      })
    } catch (e) { setNote(`Export failed: ${(e as Error).message}`) } finally { setBusy('') }
  }

  async function picked(f: File | undefined) {
    if (file.current) file.current.value = ''
    if (!f) return
    close(); setNote(''); setBusy('Reading PDF…')
    try {
      const plan = await planImportFile(f, documentId, markups)
      if (!plan.changes.length) setNote(plan.skipped ? `Nothing to import (${plural(plan.skipped, 'unsupported annotation')} skipped).` : 'No new markups found in that PDF.')
      else setPreview(plan)
    } catch (e) { setNote(`Could not read that PDF: ${(e as Error).message}`) } finally { setBusy('') }
  }

  return (
    <>
      <details className="pdf-menu" ref={menu}>
        <summary className="icon-btn" title="Export or import PDF markups" aria-label="PDF">PDF</summary>
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => run('annotated')} disabled={!!busy}>Export annotated PDF</button>
          <button role="menuitem" onClick={() => run('flattened')} disabled={!!busy}>Export flattened PDF</button>
          {!readOnly && <button role="menuitem" onClick={() => file.current?.click()} disabled={!!busy}>Import markups from PDF…</button>}
        </div>
      </details>
      <input ref={file} type="file" accept="application/pdf,.pdf" hidden onChange={e => picked(e.target.files?.[0])} />
      {(busy || note) && <div className="live-toast" role="status">{busy || note}<button className="icon-btn small" aria-label="Dismiss" hidden={!!busy} onClick={() => setNote('')}>×</button></div>}
      {preview && (
        <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
          <div className="dialog-card">
            <div className="panel-heading">Import markups from PDF</div>
            <p>
              {plural(preview.changes.length, 'markup')} will be added or updated
              {preview.restored > 0 && <> ({plural(preview.restored, 'restored exactly')})</>}
              {preview.mapped > 0 && <> ({plural(preview.mapped, 'converted from standard annotation')})</>}.
            </p>
            <ul className="muted small">
              {Object.entries(preview.byType).map(([t, n]) => <li key={t}>{n} × {t}</li>)}
            </ul>
            {preview.unchanged > 0 && <p className="muted small">{plural(preview.unchanged, 'markup')} already match this document.</p>}
            {preview.skipped > 0 && <p className="muted small">{plural(preview.skipped, 'annotation')} of unsupported kinds skipped.</p>}
            <p className="muted small">You can undo the import with Ctrl+Z.</p>
            <div className="row">
              <button onClick={() => setPreview(null)}>Cancel</button>
              <button className="primary" onClick={() => { commit(preview.changes); setNote(`Imported ${plural(preview.changes.length, 'markup')}.`); setPreview(null) }}>Import</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
