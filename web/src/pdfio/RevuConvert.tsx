import { PDFDocument } from 'pdf-lib'
import { useEffect, useMemo, useRef, useState } from 'react'
import { post } from '../api'
import { productOptionLabel, productsFor } from '../catalog/catalog'
import type { Catalog } from '../catalog/catalog'
import type { DeviceType } from '../catalog/types'
import type { Layer, SymbolSet } from '../markups/types'
import type { Change } from '../markups/useMarkups'
import { loadPdfBytes } from '../offline/cache'
import {
  buildRevuPlan, DEFAULT_DEVICE_SIZE, extractRevu, groupSignatures, labelPrefix, plainLayerNames, suggestMapping,
} from './revu'
import type { MappingAction, RevuExtract, RevuMapping, RevuSignature } from './revu'
import { loadRevuMappings, saveRevuMappings } from './revuApi'
import { cropPage, openForCrops } from './revuThumb'

interface Props {
  documentId: string
  projectId: string
  catalog: Catalog
  symbolSets: Map<string, SymbolSet>
  layers: Layer[]
  onLayersAdded: (layers: Layer[]) => void
  commit: (change: Change) => void
  /** Called after a successful conversion with a one-line summary. */
  onDone: (summary: string) => void
  onClose: () => void
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const NEW_TYPE = '__new__'

/** Dialog: lists the distinct Revu device signatures, lets the user map each one, and converts everything in one step. */
export function RevuConvert({ documentId, projectId, catalog, symbolSets, layers, onLayersAdded, commit, onDone, onClose }: Props) {
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [error, setError] = useState('')
  const [extract, setExtract] = useState<RevuExtract | null>(null)
  const [sigs, setSigs] = useState<RevuSignature[]>([])
  const [maps, setMaps] = useState<Map<string, RevuMapping>>(new Map())
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [extraTypes, setExtraTypes] = useState<DeviceType[]>([])
  const [newType, setNewType] = useState<{ sig: string; name: string; prefix: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [symbolSize, setSymbolSize] = useState(false)
  const [includePlain, setIncludePlain] = useState(true)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let crops: ReturnType<typeof openForCrops> | null = null
    ;(async () => {
      try {
        const bytes = await loadPdfBytes(documentId)
        const ex = extractRevu(await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true }))
        const list = groupSignatures(ex.candidates)
        if (!alive.current) return
        if (!list.length && !ex.others.length) { setState('empty'); return }
        const saved = await loadRevuMappings().catch(() => new Map<string, RevuMapping>())
        const sugg = { sets: [...symbolSets.values()], types: [...catalog.types.values()] }
        const initial = new Map<string, RevuMapping>()
        for (const s of list) initial.set(s.signature, saved.get(s.signature) ?? suggestMapping(s, sugg))
        if (!alive.current) return
        setExtract(ex); setSigs(list); setMaps(initial); setState('ready')
        // thumbnails: crop each signature's first device from the page itself
        crops = openForCrops(bytes.slice(0))
        const pdf = await crops.promise
        for (const s of list) {
          if (!alive.current) return
          const c = s.candidates[0]
          try {
            const url = await cropPage(pdf, c.page, c.symbolBox)
            if (alive.current) setThumbs(t => ({ ...t, [s.signature]: url }))
          } catch { /* no thumbnail for this one */ }
        }
      } catch (e) {
        if (alive.current) { setError((e as Error).message); setState('error') }
      }
    })()
    return () => { alive.current = false; crops?.destroy() }
  }, [documentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const setList = useMemo(() => [...symbolSets.values()].sort((a, b) => a.sort - b.sort), [symbolSets])
  const typesOf = (setId: string | null) =>
    setId ? [...(catalog.typesBySet.get(setId) ?? []), ...extraTypes.filter(t => t.symbol_set_id === setId && !catalog.types.has(t.id))] : []
  const update = (sig: string, patch: Partial<RevuMapping>) =>
    setMaps(m => new Map(m).set(sig, { ...m.get(sig)!, ...patch }))

  const plan = useMemo(() => {
    if (!extract) return null
    return buildRevuPlan(extract, { documentId, catalog, mappings: maps, deviceSize: DEFAULT_DEVICE_SIZE, useBboxSize: symbolSize, includePlain, newId: () => 'preview' })
  }, [extract, maps, catalog, documentId, symbolSize, includePlain])

  const unmapped = sigs.filter(s => { const m = maps.get(s.signature); return m?.action === 'device' && !m.symbol_set_id })

  async function createType(sig: RevuSignature, name: string, prefix: string) {
    const m = maps.get(sig.signature)
    if (!m?.symbol_set_id || !name.trim()) return
    setBusy('Creating device type…')
    try {
      const t = await post<DeviceType>(`/symbol-sets/${m.symbol_set_id}/device-types`, {
        name: name.trim(), tag_prefix: prefix.trim().toUpperCase() || null, icon: thumbs[sig.signature] ?? '', fields: [],
      })
      setExtraTypes(l => [...l, t])
      update(sig.signature, { device_type_id: t.id, product_id: null })
      setNewType(null)
    } catch (e) { setError(`Could not create the device type (admins only): ${(e as Error).message}`) } finally { setBusy('') }
  }

  async function convert() {
    if (!extract || !plan) return
    setBusy('Converting…'); setError('')
    try {
      // custom layers for the plain markups, named like the Revu layers
      const layerIds = new Map(layers.map(l => [l.name, l.id]))
      const added: Layer[] = []
      for (const name of plainLayerNames(extract, maps)) {
        if (layerIds.has(name)) continue
        const l = await post<Layer>(`/projects/${projectId}/layers`, { name, color: '#e03131' })
        layerIds.set(name, l.id); added.push(l)
      }
      if (added.length) onLayersAdded(added)
      const final = buildRevuPlan(extract, { documentId, catalog, mappings: maps, layerIds, useBboxSize: symbolSize, includePlain })
      await saveRevuMappings([...maps.values()]).catch(() => { /* viewers cannot save; the conversion still works */ })
      commit(final.changes)
      onDone(`Converted ${plural(final.devices, 'device')} and ${plural(final.markups, 'markup')} from Revu. Undo with Ctrl+Z.`)
    } catch (e) { setError((e as Error).message); setBusy('') }
  }

  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <div className="dialog-card revu-dialog">
        <div className="panel-heading">Convert Revu markups</div>
        {state === 'loading' && <p className="muted">Reading the markups in this PDF…</p>}
        {state === 'empty' && <p>This PDF has no Revu markups to convert.</p>}
        {state === 'error' && <p className="error">Could not read the PDF: {error}</p>}
        {state === 'ready' && plan && extract && (
          <>
            <p className="muted small">
              Each Revu device is a group of shapes and text. Groups with the same layer and label are the same kind of device:
              choose what each becomes. Your choices are saved for the next plan.
            </p>
            <div className="revu-scroll">
              <table className="revu-table">
                <thead><tr><th></th><th>Revu device</th><th>Qty</th><th>Becomes</th></tr></thead>
                <tbody>
                  {sigs.map(s => {
                    const m = maps.get(s.signature)!
                    const types = typesOf(m.symbol_set_id)
                    const products = m.device_type_id ? productsFor(catalog, m.device_type_id) : []
                    return (
                      <tr key={s.signature}>
                        <td className="revu-thumb">{thumbs[s.signature] ? <img src={thumbs[s.signature]} alt="" /> : <span className="muted small">…</span>}</td>
                        <td><b>{s.label || s.subject || '(unnamed)'}</b><div className="muted small">{s.layer || '(no layer)'}{s.subject && s.label ? ` · ${s.subject}` : ''}</div></td>
                        <td>{s.candidates.length}</td>
                        <td>
                          <select aria-label="Action" value={m.action} onChange={e => update(s.signature, { action: e.target.value as MappingAction })}>
                            <option value="device">Device</option>
                            <option value="plain">Plain markups</option>
                            <option value="skip">Skip</option>
                          </select>
                          {m.action === 'device' && (
                            <div className="revu-targets">
                              <select aria-label="Symbol set" value={m.symbol_set_id ?? ''}
                                onChange={e => update(s.signature, { symbol_set_id: e.target.value || null, device_type_id: null, product_id: null })}>
                                <option value="">Symbol set…</option>
                                {setList.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                              </select>
                              <select aria-label="Device type" value={m.device_type_id ?? ''} disabled={!m.symbol_set_id}
                                onChange={e => {
                                  if (e.target.value === NEW_TYPE) { setNewType({ sig: s.signature, name: s.label || s.subject, prefix: labelPrefix(s.label) }); return }
                                  update(s.signature, { device_type_id: e.target.value || null, product_id: null })
                                }}>
                                <option value="">(set default)</option>
                                {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                <option value={NEW_TYPE}>New device type…</option>
                              </select>
                              <select aria-label="Product" value={m.product_id ?? ''} disabled={!products.length}
                                onChange={e => update(s.signature, { product_id: e.target.value || null })}>
                                <option value="">(no product)</option>
                                {products.map(p => <option key={p.id} value={p.id}>{productOptionLabel(p)}</option>)}
                              </select>
                              {newType?.sig === s.signature && (
                                <div className="row revu-newtype">
                                  <input aria-label="New type name" value={newType.name} onChange={e => setNewType({ ...newType, name: e.target.value })} placeholder="Name" />
                                  <input aria-label="Tag prefix" value={newType.prefix} size={5} onChange={e => setNewType({ ...newType, prefix: e.target.value })} placeholder="Prefix" />
                                  <button onClick={() => createType(s, newType.name, newType.prefix)} disabled={!newType.name.trim() || !!busy}>Create</button>
                                  <button onClick={() => setNewType(null)}>Cancel</button>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <label className="check"><input type="checkbox" checked={symbolSize} onChange={e => setSymbolSize(e.target.checked)} /> Size devices like the Revu symbol (otherwise {DEFAULT_DEVICE_SIZE} pt)</label>
            <label className="check"><input type="checkbox" checked={includePlain} onChange={e => setIncludePlain(e.target.checked)} /> Also import the other annotations as plain markups</label>
            <p>
              <b>{plural(plan.devices, 'device')}</b> and <b>{plural(plan.markups, 'plain markup')}</b> will be added
              {plan.skippedDevices > 0 && <>; {plural(plan.skippedDevices, 'device')} skipped</>}
              {plan.skipped > 0 && <>; {plural(plan.skipped, 'annotation')} not imported (links and other kinds)</>}.
            </p>
            <p className="muted small">
              The PDF itself is never changed. Tags are numbered automatically, and the original Revu codes are kept in each device (Revu code).
              The PDF's own annotations are hidden afterwards so nothing shows twice (PDF menu, Show original PDF annotations).
            </p>
            {unmapped.length > 0 && <p className="scale-warn small">{plural(unmapped.length, 'device kind')} still need a symbol set; they will be skipped.</p>}
          </>
        )}
        {error && state !== 'error' && <p className="error">{error}</p>}
        <div className="row">
          <button onClick={onClose} disabled={!!busy}>{state === 'ready' ? 'Cancel' : 'Close'}</button>
          {state === 'ready' && (
            <button className="primary" onClick={convert} disabled={!!busy || !plan?.changes.length}>
              {busy || 'Convert'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

