import { useState } from 'react'
import { defaultProductId, productOptionLabel, productsFor } from '../catalog/catalog'
import { useCatalogContext } from '../catalog/useCatalog'
import type { ReplaceTarget } from './replaceDevice'
import type { Markup, SymbolSet } from './types'

interface Props {
  devices: Markup[]
  symbolSets: SymbolSet[]
  onApply: (t: ReplaceTarget) => void
  onClose: () => void
}

/** Pick a symbol set, device type and product to swap the selected devices for. */
export function ReplaceDialog({ devices, symbolSets, onApply, onClose }: Props) {
  const cat = useCatalogContext()
  const first = devices[0]
  const [setId, setSetId] = useState(first?.symbol_set_id ?? symbolSets[0]?.id ?? '')
  const [typeId, setTypeId] = useState<string>(first?.device_type_id ?? '')
  const [productId, setProductId] = useState<string>(first?.product_id ?? '')
  const types = cat.typesBySet.get(setId) ?? []
  const products = typeId ? productsFor(cat, typeId) : []
  const changeSet = (id: string) => {
    setSetId(id)
    const t = cat.typesBySet.get(id)?.[0]
    setTypeId(t?.id ?? '')
    setProductId(t ? defaultProductId(cat, t.id) ?? '' : '')
  }
  const changeType = (id: string) => { setTypeId(id); setProductId(id ? defaultProductId(cat, id) ?? '' : '') }
  const n = devices.length
  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <form onSubmit={e => { e.preventDefault(); if (setId) onApply({ setId, typeId: typeId || null, productId: productId || null }) }}
        onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <div className="panel-heading">Replace {n === 1 ? (first.tag || 'device') : `${n} devices`} with…</div>
        <label className="field">Symbol set
          <select value={setId} onChange={e => changeSet(e.target.value)} autoFocus>
            {symbolSets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field">Device type
          <select value={typeId} onChange={e => changeType(e.target.value)}>
            <option value="">Any type</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {typeId && (
          <label className="field">Product
            <select value={productId} onChange={e => setProductId(e.target.value)}>
              <option value="">Unassigned</option>
              {products.map(p => <option key={p.id} value={p.id}>{productOptionLabel(p)}</option>)}
            </select>
          </label>
        )}
        <p className="muted small">
          Position, size, rotation, area, photos and matching fields are kept. A tag is renumbered when the prefix changes. You can undo this in one step.
        </p>
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!setId}>Replace</button>
        </div>
      </form>
    </div>
  )
}
