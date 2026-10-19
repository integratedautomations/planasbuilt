import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post } from '../api'
import type { User } from '../api'
import { BtxImport } from '../catalog/BtxImport'
import { CatalogImport, exportCatalogExcel } from '../catalog/CatalogImport'
import { FieldsEditor } from '../catalog/FieldsEditor'
import { ProductsTable } from '../catalog/ProductsTable'
import { readIcon } from '../catalog/readIcon'
import type { DeviceType } from '../catalog/types'
import { useCatalog } from '../catalog/useCatalog'
import type { FieldDef, SymbolSet } from '../markups/types'
import { HARDWARE_FIELDS } from '../markups/types'

type Draft = Omit<SymbolSet, 'id' | 'sort'> & { id?: string }
const EMPTY: Draft = { name: '', color: '#1971c2', tag_prefix: '', icon: '', fields: [], has_fov: false }

interface TypeDraft { id?: string; name: string; tag_prefix: string; icon: string; fields: FieldDef[]; default_product_id: string | null }
/** Nav selection: a set, one of its device types, or the standalone accessories list. */
type Sel = { kind: 'set'; setId: string } | { kind: 'type'; setId: string; typeId: string } | { kind: 'accessories' } | null

/** Admin catalog: symbol sets > device types > products, plus Excel and Revu (.btx) loading. */
export function SymbolSetsPage({ user }: { user: User }) {
  const [sets, setSets] = useState<SymbolSet[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [typeDraft, setTypeDraft] = useState<(TypeDraft & { setId: string }) | null>(null)
  const [sel, setSel] = useState<Sel>(null)
  const [dialog, setDialog] = useState<'excel' | 'btx' | null>(null)
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

  async function saveType() {
    if (!typeDraft) return
    setError('')
    try {
      const body = JSON.stringify({ name: typeDraft.name, tag_prefix: typeDraft.tag_prefix, icon: typeDraft.icon, fields: typeDraft.fields, default_product_id: typeDraft.default_product_id })
      const saved = typeDraft.id
        ? await api<DeviceType>(`/device-types/${typeDraft.id}`, { method: 'PUT', body })
        : await api<DeviceType>(`/symbol-sets/${typeDraft.setId}/device-types`, { method: 'POST', body })
      await reload()
      setSel({ kind: 'type', setId: typeDraft.setId, typeId: saved.id })
      setTypeDraft(null)
    } catch (e) { setError((e as Error).message) }
  }

  async function removeType(t: DeviceType) {
    if (!confirm(`Remove device type "${t.name}"? Devices already placed keep their type; it just leaves the palette.`)) return
    await api(`/device-types/${t.id}`, { method: 'DELETE' })
    await reload()
    setTypeDraft(null); setSel({ kind: 'set', setId: t.symbol_set_id })
  }

  const selSet = sel && sel.kind !== 'accessories' ? sets.find(s => s.id === sel.setId) : undefined
  const selType = sel?.kind === 'type' ? catalog.types.get(sel.typeId) : undefined
  const products = useMemo(() => {
    if (sel?.kind === 'type') return data.products.filter(p => p.device_type_id === sel.typeId)
    if (sel?.kind === 'accessories') return data.products.filter(p => !p.device_type_id)
    return []
  }, [data.products, sel])
  const typePrefixHint = (t: DeviceType, s: SymbolSet) => `${t.tag_prefix || s.tag_prefix}-01`

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">PlanAsBuilt</Link>
        <span className="muted">/</span>
        <span className="crumb">Catalog</span>
      </header>
      <main className="content">
        {!admin && <p className="muted">Only admins can edit the catalog.</p>}
        <div className="row wrap">
          <h2>Catalog</h2>
          <span className="spacer" />
          <button onClick={() => exportCatalogExcel(data, sets).catch(e => setError(e.message))} title="Download the catalog as an Excel workbook">Export Excel</button>
          {admin && <button onClick={() => setDialog('excel')}>Import Excel</button>}
          {admin && <button onClick={() => setDialog('btx')} title="Convert a Bluebeam Revu tool set into device types">Import Revu .btx</button>}
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
                    <span className="set-icon" style={{ background: s.color, width: 20, height: 20 }}>{(t.icon || s.icon) && <img src={t.icon || s.icon} alt="" />}</span>{t.name}
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
                  <span className="muted"> · {selSet.tag_prefix}-01 · {selSet.fields.length} field{selSet.fields.length === 1 ? '' : 's'}{selSet.has_fov ? ' · coverage cone' : ''}</span>
                  <span className="spacer" />
                  {admin && <button onClick={() => setDraft({ ...selSet, fields: selSet.fields.map(f => ({ ...f })) })}>Edit set</button>}
                  {admin && <button className="primary" onClick={() => setTypeDraft({ setId: selSet.id, name: '', tag_prefix: '', icon: '', fields: [], default_product_id: null })}>New device type</button>}
                </div>
                <ul className="list">
                  {(catalog.typesBySet.get(selSet.id) ?? []).map(t => (
                    <li key={t.id}>
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
                  {admin && <button onClick={() => setTypeDraft({ ...selType, tag_prefix: selType.tag_prefix ?? '', setId: selSet.id, fields: selType.fields.map(f => ({ ...f })) })}>Edit type</button>}
                </div>
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
              <label className="field">Icon (SVG or PNG)
                <span className="row">
                  <span className="set-icon" style={{ background: draft.color }}>{draft.icon && <img src={draft.icon} alt="" />}</span>
                  <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp"
                    onChange={async e => { const f = e.target.files?.[0]; if (f) setDraft({ ...draft, icon: await readIcon(f) }) }} />
                </span>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={draft.has_fov}
              onChange={e => setDraft({ ...draft, has_fov: e.target.checked })} /> Show coverage cone (cameras, motion sensors)</label>

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
        <div className="modal-backdrop" onClick={() => setTypeDraft(null)}>
          <div className="card modal wide" onClick={e => e.stopPropagation()}>
            <div className="row"><h3>{typeDraft.id ? 'Edit device type' : 'New device type'}</h3><span className="spacer" />
              <button onClick={() => setTypeDraft(null)}>Close</button></div>
            <div className="grid2">
              <label className="field">Name<input value={typeDraft.name} onChange={e => setTypeDraft({ ...typeDraft, name: e.target.value })} /></label>
              <label className="field">Tag prefix (blank = set's prefix)
                <input value={typeDraft.tag_prefix} placeholder={sets.find(s => s.id === typeDraft.setId)?.tag_prefix}
                  onChange={e => setTypeDraft({ ...typeDraft, tag_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
              </label>
              <label className="field">Icon (blank = set's icon)
                <span className="row">
                  <span className="set-icon" style={{ background: sets.find(s => s.id === typeDraft.setId)?.color }}>
                    {(typeDraft.icon || sets.find(s => s.id === typeDraft.setId)?.icon) && <img src={typeDraft.icon || sets.find(s => s.id === typeDraft.setId)?.icon} alt="" />}</span>
                  <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp"
                    onChange={async e => { const f = e.target.files?.[0]; if (f) setTypeDraft({ ...typeDraft, icon: await readIcon(f) }) }} />
                  {typeDraft.icon && <button onClick={() => setTypeDraft({ ...typeDraft, icon: '' })}>Use set icon</button>}
                </span>
              </label>
            </div>
            <h4>Extra fields</h4>
            <p className="muted small">On top of the set's fields. Devices of this type show both.</p>
            <FieldsEditor fields={typeDraft.fields} onChange={fields => setTypeDraft({ ...typeDraft, fields })} />
            {error && <div className="error">{error}</div>}
            <div className="row">
              {typeDraft.id && <button className="danger" onClick={() => removeType(catalog.types.get(typeDraft.id!)!)}>Remove type</button>}
              <span className="spacer" />
              <button className="primary" onClick={saveType} disabled={!typeDraft.name.trim()}>Save</button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'excel' && <CatalogImport data={data} sets={sets} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'btx' && <BtxImport data={data} sets={sets} onClose={() => setDialog(null)} onDone={reload} />}
    </div>
  )
}
