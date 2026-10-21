import { MountBadge } from '../catalog/MountBadge'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post } from '../api'
import type { User } from '../api'
import { BtxImport } from '../catalog/BtxImport'
import { CatalogImport, exportCatalogExcel } from '../catalog/CatalogImport'
import { DeviceTypeEditor, draftOfType } from '../catalog/DeviceTypeEditor'
import type { TypeDraft } from '../catalog/DeviceTypeEditor'
import { FieldsEditor } from '../catalog/FieldsEditor'
import { StandardLibraryDialog } from '../catalog/StandardLibraryDialog'
import { ProductsTable } from '../catalog/ProductsTable'
import { readIcon } from '../catalog/readIcon'
import { IconPicker } from '../catalog/icons/IconPicker'
import { moveBefore } from '../prefs/chest'
import type { DeviceType } from '../catalog/types'
import { useCatalog } from '../catalog/useCatalog'
import type { SymbolSet } from '../markups/types'
import { HARDWARE_FIELDS } from '../markups/types'
import { Brand } from '../Brand'
import { UserMenu } from '../settings/UserMenu'

type Draft = Omit<SymbolSet, 'id' | 'sort'> & { id?: string }
const EMPTY: Draft = { name: '', color: '#1971c2', tag_prefix: '', icon: '', fields: [], has_fov: false }

/** Nav selection: a set, one of its device types, or the standalone accessories list. */
type Sel = { kind: 'set'; setId: string } | { kind: 'type'; setId: string; typeId: string } | { kind: 'accessories' } | null

/** Admin catalog: symbol sets > device types > products, plus Excel and Revu (.btx) loading. */
export function SymbolSetsPage({ user }: { user: User }) {
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [typeDraft, setTypeDraft] = useState<TypeDraft | null>(null)
  const [sel, setSel] = useState<Sel>(null)
  const [dialog, setDialog] = useState<'excel' | 'btx' | 'library' | null>(null)
  /** Which editor the icon picker fills in. */
  const [picking, setPicking] = useState<'set' | null>(null)
  const [dragType, setDragType] = useState<string | null>(null)
  const [overType, setOverType] = useState<string | null>(null)
  const [error, setError] = useState('')
  const { data, catalog, reload } = useCatalog()
  const admin = user.is_admin

  const loadSets = () => api<SymbolSet[]>('/symbol-sets').then(setSets).catch(e => setError(e.message))
  useEffect(() => { void loadSets() }, [])

  // Select the first set once loaded
  useEffect(() => { if (!sel && sets.length) setSel({ kind: 'set', setId: sets[0].id }) }, [sets, sel])

  async function save() {
    if (!draft) return
    setError('')
    try {
      const saved = draft.id
        ? await api<SymbolSet>(`/symbol-sets/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) })
        : await post<SymbolSet>('/symbol-sets', draft)
      setSets(ss => draft.id ? ss.map(s => (s.id === saved.id ? saved : s)) : [...ss, saved])
      setDraft(null)
    } catch (e) { setError((e as Error).message) }
  }

  async function archive(s: SymbolSet) {
    if (!confirm(`Remove "${s.name}" from the palette? Devices already placed keep their data.`)) return
    await api(`/symbol-sets/${s.id}`, { method: 'DELETE' })
    setSets(ss => ss.filter(x => x.id !== s.id))
    setDraft(null); setSel(null)
  }

  /** Persists a new order for a set's device types (drag handles or the up / down buttons). */
  async function reorderTypes(setId: string, ids: string[]) {
    setError('')
    try {
      await api(`/symbol-sets/${setId}/device-types/order`, { method: 'PUT', body: JSON.stringify({ ids }) })
      await reload()
    } catch (e) { setError((e as Error).message) }
  }

  const selSet = sel && sel.kind !== 'accessories' ? sets.find(s => s.id === sel.setId) : undefined
  const selType = sel?.kind === 'type' ? catalog.types.get(sel.typeId) : undefined
  const products = useMemo(() => {
    if (sel?.kind === 'type') return data.products.filter(p => p.device_type_id === sel.typeId)
    if (sel?.kind === 'accessories') return data.products.filter(p => !p.device_type_id)
    return []
  }, [data.products, sel])
  const typeIds = (setId: string) => (catalog.typesBySet.get(setId) ?? []).map(x => x.id)
  const typePrefixHint = (t: DeviceType, s: SymbolSet) => `${t.tag_prefix || s.tag_prefix}-01`

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <span className="muted">/</span>
        <span className="crumb">Catalog</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <main className="content content-wide">
        {!admin && <p className="muted">Only admins can edit the catalog.</p>}
        <div className="row wrap">
          <h2>Catalog</h2>
          <span className="spacer" />
          <button onClick={() => exportCatalogExcel(data, sets).catch(e => setError(e.message))} title="Download the catalog as an Excel workbook">Export Excel</button>
          {admin && <button onClick={() => setDialog('excel')}>Import Excel</button>}
          {admin && <button onClick={() => setDialog('btx')} title="Convert a Bluebeam Revu tool set into device types">Import Revu .btx</button>}
          {admin && <button onClick={() => setDialog('library')} title="Add the built-in symbol sets and device types, or fill in missing icons and defaults. Never deletes anything.">Install / update standard library</button>}
          {admin && <button className="primary" onClick={() => setDraft({ ...EMPTY })}>New set</button>}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="catalog-grid">
          <nav className="catalog-nav" aria-label="Sets and device types">
            {sets.map(s => (
              <div key={s.id} className="catalog-nav">
                <button className={sel?.kind === 'set' && sel.setId === s.id ? 'on' : ''} onClick={() => setSel({ kind: 'set', setId: s.id })}>
                  <span className="set-icon" style={{ background: s.color }}>{s.icon && <img src={s.icon} alt="" />}</span>{s.name}
                </button>
                {(catalog.typesBySet.get(s.id) ?? []).map(t => (
                  <button key={t.id} className={'sub' + (sel?.kind === 'type' && sel.typeId === t.id ? ' on' : '')} onClick={() => setSel({ kind: 'type', setId: s.id, typeId: t.id })}>
                    <MountBadge mount={t.mount ?? 'ceiling'} color={s.color} src={t.icon || s.icon || undefined} size={22} />{t.name}
                  </button>
                ))}
              </div>
            ))}
            <button className={sel?.kind === 'accessories' ? 'on' : ''} onClick={() => setSel({ kind: 'accessories' })}>Standalone accessories</button>
          </nav>

          <section aria-label="Details" className="stack">
            {sel?.kind === 'set' && selSet && (
              <>
                <div className="row wrap">
                  <h3>{selSet.name}</h3>
                  <span className="muted"> · {selSet.tag_prefix}-01 · {selSet.fields.length} field{selSet.fields.length === 1 ? '' : 's'}{selSet.has_fov ? ' · coverage' : ''}</span>
                  <span className="spacer" />
                  {admin && <button onClick={() => setDraft({ ...selSet, fields: selSet.fields.map(f => ({ ...f })) })}>Edit set</button>}
                  {admin && <button className="primary" onClick={() => setTypeDraft({ setId: selSet.id, name: '', tag_prefix: '', icon: '', fields: [], default_product_id: null, coverage: { on: false, angle: 90, range_ft: 20 } })}>New device type</button>}
                </div>
                <ul className="list">
                  {(catalog.typesBySet.get(selSet.id) ?? []).map(t => (
                    <li key={t.id} className={'type-row' + (dragType === t.id ? ' dragging' : '') + (overType === t.id && dragType !== t.id ? ' over' : '')}
                      draggable={admin}
                      onDragStart={e => { setDragType(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id) }}
                      onDragOver={e => { if (dragType) { e.preventDefault(); setOverType(t.id) } }}
                      onDragLeave={() => setOverType(o => (o === t.id ? null : o))}
                      onDrop={e => {
                        e.preventDefault()
                        if (dragType && dragType !== t.id) void reorderTypes(selSet.id, moveBefore(typeIds(selSet.id), dragType, t.id))
                        setDragType(null); setOverType(null)
                      }}
                      onDragEnd={() => { setDragType(null); setOverType(null) }}>
                      {admin && <span className="type-handle" title="Drag to reorder" aria-hidden>{'\u2807'}</span>}
                      <button className="list-item set-item" onClick={() => setSel({ kind: 'type', setId: selSet.id, typeId: t.id })}>
                        <span className="set-icon" style={{ background: selSet.color }}>{(t.icon || selSet.icon) && <img src={t.icon || selSet.icon} alt="" />}</span>
                        <span className="grow">
                          <span className="list-title">{t.name}</span>
                          <span className="muted"> · {typePrefixHint(t, selSet)} · {catalog.productsByType.get(t.id)?.length ?? 0} product{(catalog.productsByType.get(t.id)?.length ?? 0) === 1 ? '' : 's'}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {(catalog.typesBySet.get(selSet.id) ?? []).length === 0 && <li className="muted">No device types yet. Devices of this set are placed without a type or product.</li>}
                </ul>
              </>
            )}

            {sel?.kind === 'type' && selSet && selType && (
              <>
                <div className="row wrap">
                  <h3>{selSet.name} › {selType.name}</h3>
                  <span className="muted"> · tags {typePrefixHint(selType, selSet)}{selType.fields.length ? ` · ${selType.fields.length} extra field${selType.fields.length === 1 ? '' : 's'}` : ''}</span>
                  <span className="spacer" />
                </div>
                {admin && (
                  <DeviceTypeEditor inline key={`${selType.id}:${JSON.stringify(selType)}`} initial={draftOfType(selType)} set={selSet}
                    onClose={() => {}}
                    onSaved={async saved => { await reload(); setSel({ kind: 'type', setId: selSet.id, typeId: saved.id }) }}
                    onRemoved={async (_id, setId) => { await reload(); setSel({ kind: 'set', setId }) }} />
                )}
                <h4>Products</h4>
                <ProductsTable products={products} allProducts={data.products} type={selType} set={selSet} admin={admin} onChanged={reload} onError={setError} />
              </>
            )}

            {sel?.kind === 'accessories' && (
              <>
                <h3>Standalone accessories</h3>
                <p className="muted small">Parts that belong to no device type (bases, mounts, power supplies). Attach them to products as accessories.</p>
                <ProductsTable products={products} allProducts={data.products} type={null} admin={admin} onChanged={reload} onError={setError} />
              </>
            )}
          </section>
        </div>
      </main>

      {draft && (
        <div className="modal-backdrop" onClick={() => setDraft(null)}>
          <div className="card modal wide" onClick={e => e.stopPropagation()}>
            <div className="row"><h3>{draft.id ? 'Edit symbol set' : 'New symbol set'}</h3><span className="spacer" />
              <button onClick={() => setDraft(null)}>Close</button></div>
            <div className="grid2">
              <label className="field">Name<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
              <label className="field">Tag prefix
                <input value={draft.tag_prefix} placeholder="CAM"
                  onChange={e => setDraft({ ...draft, tag_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
              </label>
              <label className="field">Category color
                <input type="color" value={draft.color} onChange={e => setDraft({ ...draft, color: e.target.value })} />
              </label>
              <label className="field">Icon (library, SVG or PNG)
                <span className="icon-pick-row">
                  <span className="set-icon" style={{ background: draft.color }}>{draft.icon && <img src={draft.icon} alt="" />}</span>
                  <button type="button" onClick={() => setPicking('set')}>Choose from library…</button>
                  <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp"
                    onChange={async e => { const f = e.target.files?.[0]; if (f) setDraft({ ...draft, icon: await readIcon(f) }) }} />
                </span>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={draft.has_fov}
              onChange={e => setDraft({ ...draft, has_fov: e.target.checked })} /> Coverage on by default (cameras, motion sensors)</label>

            <h4>Fields</h4>
            <p className="muted small">Every device also has: {HARDWARE_FIELDS.map(f => f.label).join(', ')}, and install status. Device types can add their own fields.</p>
            <FieldsEditor fields={draft.fields} onChange={fields => setDraft({ ...draft, fields })} />
            {error && <div className="error">{error}</div>}
            <div className="row">
              {draft.id && <button className="danger" onClick={() => archive(draft as SymbolSet)}>Remove set</button>}
              <span className="spacer" />
              <button className="primary" onClick={save} disabled={!draft.name.trim() || !draft.tag_prefix}>Save</button>
            </div>
          </div>
        </div>
      )}

      {typeDraft && (
        <DeviceTypeEditor key={typeDraft.id ?? 'new'} initial={typeDraft} set={sets.find(x => x.id === typeDraft.setId)}
          onClose={() => setTypeDraft(null)}
          onSaved={async saved => { await reload(); setSel({ kind: 'type', setId: typeDraft.setId, typeId: saved.id }); setTypeDraft(null) }}
          onRemoved={async (_id, setId) => { await reload(); setTypeDraft(null); setSel({ kind: 'set', setId }) }} />
      )}

      {picking && (
        <IconPicker color={draft?.color ?? '#1971c2'}
          onClose={() => setPicking(null)}
          onPick={url => { if (draft) setDraft({ ...draft, icon: url }); setPicking(null) }} />
      )}

      {dialog === 'excel' && <CatalogImport data={data} sets={sets} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'library' && <StandardLibraryDialog onClose={() => setDialog(null)} onDone={async () => { await loadSets(); await reload() }} />}
      {dialog === 'btx' && <BtxImport data={data} sets={sets} onClose={() => setDialog(null)} onDone={reload} />}
    </div>
  )
}
