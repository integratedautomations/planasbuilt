import { useEffect, useState } from 'react'
import { api, post } from '../api'
import { HARDWARE_FIELDS } from '../markups/types'
import type { SymbolSet } from '../markups/types'
import { fieldDefsFor, productLabel } from './catalog'
import type { Accessory, DeviceType, Product } from './types'

interface Props {
  /** Products shown: those of `type`, or the standalone accessories when type is null. */
  products: Product[]
  allProducts: Product[]
  type: DeviceType | null
  set?: SymbolSet
  admin: boolean
  /** False for roles that may not see unit costs and labor hours (default true). */
  showCosts?: boolean
  onChanged: () => void
  onError: (msg: string) => void
}

const save = (p: Product) => api<Product>(`/products/${p.id}`, { method: 'PUT', body: JSON.stringify(p) })
const num = (v: string) => (v === '' ? 0 : Math.max(0, Number(v) || 0))

/** Inline-editable product list for one device type (or the standalone accessories). */
export function ProductsTable({ products, allProducts, type, set, admin, showCosts = true, onChanged, onError }: Props) {
  const [details, setDetails] = useState<Product | null>(null)
  const [add, setAdd] = useState({ manufacturer: '', model: '', name: '' })

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); onChanged() } catch (e) { onError((e as Error).message) }
  }

  async function addProduct() {
    if (!add.manufacturer.trim() && !add.model.trim() && !add.name.trim()) return
    await run(async () => {
      await post('/products', { ...add, kind: type ? 'device' : 'accessory', device_type_id: type?.id })
      setAdd({ manufacturer: '', model: '', name: '' })
    })
  }

  const makeDefault = (p: Product) => type && run(() =>
    api(`/device-types/${type.id}`, { method: 'PUT', body: JSON.stringify({ ...type, default_product_id: p.id }) }))

  const remove = (p: Product) => {
    if (!confirm(`Delete "${productLabel(p) || p.name}"? If devices use it, it is deactivated instead.`)) return
    void run(() => api(`/products/${p.id}`, { method: 'DELETE' }))
  }

  return (
    <>
      <div className="table-scroll">
        <table className="product-table">
          <thead>
            <tr>
              {type && <th title="Default product for this type">Default</th>}
              <th>Manufacturer</th><th>Model</th><th>Name</th><th>Spec link</th>
              {showCosts && <><th>Unit cost</th><th>Labor hrs</th></>}<th>Accessories</th><th>Active</th><th />
            </tr>
          </thead>
          <tbody>
            {products.map(p => (
              <ProductRow key={p.id} p={p} isDefault={type?.default_product_id === p.id} showStar={!!type} admin={admin} showCosts={showCosts}
                onSave={d => run(() => save(d))} onDefault={() => makeDefault(p)} onDetails={() => setDetails(p)} onDelete={() => remove(p)} />
            ))}
            {products.length === 0 && <tr><td colSpan={10} className="muted">No products yet.</td></tr>}
            {admin && (
              <tr>
                {type && <td />}
                <td><input placeholder="Manufacturer" value={add.manufacturer} onChange={e => setAdd({ ...add, manufacturer: e.target.value })} /></td>
                <td><input placeholder="Model" value={add.model} onChange={e => setAdd({ ...add, model: e.target.value })} /></td>
                <td><input placeholder="Name" value={add.name} onChange={e => setAdd({ ...add, name: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') void addProduct() }} /></td>
                <td colSpan={6}><button className="primary" onClick={addProduct}>Add product</button></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {details && (
        <ProductDetails product={details} allProducts={allProducts} type={type} set={set} admin={admin} showCosts={showCosts}
          onClose={() => setDetails(null)}
          onSave={async d => { await run(() => save(d)); setDetails(null) }} />
      )}
    </>
  )
}

function ProductRow({ p, isDefault, showStar, admin, showCosts, onSave, onDefault, onDetails, onDelete }: {
  p: Product; isDefault: boolean; showStar: boolean; admin: boolean; showCosts: boolean
  onSave: (p: Product) => void; onDefault: () => void; onDetails: () => void; onDelete: () => void
}) {
  const [d, setD] = useState(p)
  useEffect(() => setD(p), [p])
  const commit = (next: Product = d) => {
    if (JSON.stringify(next) !== JSON.stringify(p)) onSave(next)
  }
  const text = (key: 'manufacturer' | 'model' | 'name' | 'spec_url', label: string) => (
    <input aria-label={label} disabled={!admin} value={d[key]} onChange={e => setD({ ...d, [key]: e.target.value })} onBlur={() => commit()} />
  )
  return (
    <tr style={p.active ? undefined : { opacity: 0.55 }}>
      {showStar && (
        <td><button className={'star' + (isDefault ? ' on' : '')} disabled={!admin || !p.active} aria-label={isDefault ? 'Default product' : 'Make default'}
          aria-pressed={isDefault} title={isDefault ? 'Default product' : 'Make default'} onClick={onDefault}>{isDefault ? '★' : '☆'}</button></td>
      )}
      <td>{text('manufacturer', 'Manufacturer')}</td>
      <td>{text('model', 'Model')}</td>
      <td>{text('name', 'Name')}</td>
      <td>{text('spec_url', 'Spec link')}{/^https?:/i.test(d.spec_url) && <a href={d.spec_url} target="_blank" rel="noreferrer" title="Open spec"> ↗</a>}</td>
      {showCosts && <>
        <td><input className="num" aria-label="Unit cost" inputMode="decimal" disabled={!admin} value={d.unit_cost}
          onChange={e => setD({ ...d, unit_cost: num(e.target.value) })} onBlur={() => commit()} /></td>
        <td><input className="num" aria-label="Labor hours" inputMode="decimal" disabled={!admin} value={d.labor_hours}
          onChange={e => setD({ ...d, labor_hours: num(e.target.value) })} onBlur={() => commit()} /></td>
      </>}
      <td><button onClick={onDetails}>{p.accessories.length ? `${p.accessories.length} item${p.accessories.length === 1 ? '' : 's'}` : 'None'}{' / defaults'}</button></td>
      <td><input type="checkbox" aria-label="Active" disabled={!admin} checked={d.active} onChange={e => { const n = { ...d, active: e.target.checked }; setD(n); commit(n) }} /></td>
      <td>{admin && <button className="icon-btn small danger" title="Delete product" aria-label="Delete product" onClick={onDelete}>✕</button>}</td>
    </tr>
  )
}

/** Accessories picker and default field values for one product. */
function ProductDetails({ product, allProducts, type, set, admin, showCosts, onClose, onSave }: {
  product: Product; allProducts: Product[]; type: DeviceType | null; set?: SymbolSet; admin: boolean; showCosts: boolean
  onClose: () => void; onSave: (p: Product) => void | Promise<void>
}) {
  const [d, setD] = useState(product)
  const choices = allProducts.filter(x => x.id !== product.id).sort((a, b) => productLabel(a).localeCompare(productLabel(b)))
  const setAcc = (i: number, a: Accessory) => setD({ ...d, accessories: d.accessories.map((x, j) => (j === i ? a : x)) })
  const defs = [...fieldDefsFor(set, type ?? undefined), ...HARDWARE_FIELDS.filter(f => !['manufacturer', 'model'].includes(f.key) && f.key !== 'serial')]
  const setDefault = (key: string, v: string) => {
    const next = { ...d.default_fields }
    if (v === '') delete next[key]; else next[key] = v
    setD({ ...d, default_fields: next })
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal wide" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>{productLabel(product) || product.name}</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>

        <h4>Accessories</h4>
        <p className="muted small">Added to the bill of materials automatically for every device with this product.</p>
        <div className="stack">
          {d.accessories.map((a, i) => (
            <div key={i} className="field-row">
              {'product_id' in a ? (
                <select disabled={!admin} value={a.product_id} onChange={e => setAcc(i, { product_id: e.target.value, qty: a.qty })}>
                  {!choices.some(c => c.id === a.product_id) && <option value={a.product_id}>(missing product)</option>}
                  {choices.map(c => <option key={c.id} value={c.id}>{productLabel(c) || c.name}{c.kind === 'accessory' ? ' (accessory)' : ''}</option>)}
                </select>
              ) : (
                <>
                  <input placeholder="Item name" disabled={!admin} value={a.name} onChange={e => setAcc(i, { ...a, name: e.target.value })} />
                  {showCosts && <>
                    <input className="num" placeholder="Cost" inputMode="decimal" disabled={!admin} value={a.unit_cost ?? 0} onChange={e => setAcc(i, { ...a, unit_cost: num(e.target.value) })} />
                    <input className="num" placeholder="Labor" inputMode="decimal" disabled={!admin} value={a.labor_hours ?? 0} onChange={e => setAcc(i, { ...a, labor_hours: num(e.target.value) })} />
                  </>}
                </>
              )}
              <input className="num" type="number" min={1} aria-label="Quantity" disabled={!admin} value={a.qty}
                onChange={e => setAcc(i, { ...a, qty: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
              {admin && <button className="icon-btn small danger" aria-label="Remove accessory" onClick={() => setD({ ...d, accessories: d.accessories.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          {admin && (
            <span className="row">
              <button disabled={choices.length === 0} onClick={() => setD({ ...d, accessories: [...d.accessories, { product_id: choices[0].id, qty: 1 }] })}>+ Existing product</button>
              <button onClick={() => setD({ ...d, accessories: [...d.accessories, { name: '', unit_cost: 0, labor_hours: 0, qty: 1 }] })}>+ One-off item</button>
            </span>
          )}
        </div>

        <h4>Default field values</h4>
        <p className="muted small">Filled in when a device is placed with this product. Manufacturer and model always come from the product.</p>
        <div className="grid2">
          {defs.map(f => (
            <label key={f.key} className="field">{f.label}
              {f.type === 'select' ? (
                <select disabled={!admin} value={String(d.default_fields[f.key] ?? '')} onChange={e => setDefault(f.key, e.target.value)}>
                  <option value="">—</option>{(f.options ?? []).map(o => <option key={o}>{o}</option>)}
                </select>
              ) : f.type === 'checkbox' ? (
                <input type="checkbox" disabled={!admin} checked={!!d.default_fields[f.key]}
                  onChange={e => setD({ ...d, default_fields: { ...d.default_fields, [f.key]: e.target.checked } })} />
              ) : (
                <input disabled={!admin} value={String(d.default_fields[f.key] ?? '')} onChange={e => setDefault(f.key, e.target.value)} />
              )}
            </label>
          ))}
        </div>
        {admin && (
          <div className="row"><span className="spacer" />
            <button className="primary" onClick={() => onSave({ ...d, accessories: d.accessories.filter(a => 'product_id' in a || a.name.trim()) })}>Save</button></div>
        )}
      </div>
    </div>
  )
}
