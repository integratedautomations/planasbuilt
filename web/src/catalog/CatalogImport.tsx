import { useMemo, useState } from 'react'
import { api, post } from '../api'
import type { SymbolSet } from '../markups/types'
import { catalogTable, parseCatalogSheets, planCatalogImport, productKey, resolveAccessories } from './catalogIO'
import type { PlanItem } from './catalogIO'
import type { CatalogData, DeviceType, Product } from './types'
import type { ImportSheet } from '../schedule/importDiff'

/** Downloads the whole catalog as a one-sheet Excel workbook. */
export async function exportCatalogExcel(data: CatalogData, sets: SymbolSet[]) {
  const { downloadWorkbook } = await import('../schedule/xlsxIO')
  await downloadWorkbook([catalogTable(data, sets)], 'PlanAsBuilt catalog.xlsx')
}

const ACTION_LABEL = { create: 'New', update: 'Update', unchanged: 'No change', error: 'Skipped' } as const

/** Excel import: reads the Products sheet, shows what would change (matched by manufacturer + model), then applies it. */
export function CatalogImport({ data, sets, onClose, onDone }: {
  data: CatalogData; sets: SymbolSet[]; onClose: () => void; onDone: () => void
}) {
  const [sheets, setSheets] = useState<ImportSheet[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState('')
  const plan = useMemo(() => (sheets ? planCatalogImport(parseCatalogSheets(sheets), data, sets) : null), [sheets, data, sets])

  async function pick(file: File | undefined) {
    if (!file) return
    setError(''); setResult('')
    try {
      const { readWorkbook } = await import('../schedule/xlsxIO')
      setSheets(await readWorkbook(file)); setFileName(file.name)
    } catch (e) { setError(`Could not read that file: ${(e as Error).message}`) }
  }

  async function apply() {
    if (!plan) return
    setBusy('Importing…'); setError('')
    let failed = 0
    try {
      const todo = plan.items.filter(i => i.action === 'create' || i.action === 'update')
      // 1. device types that do not exist yet
      const typeIds = new Map<string, string>()
      const typeKey = (i: PlanItem) => `${i.setId}|${i.row.type.toLowerCase()}`
      for (const i of todo) {
        if (!i.newType || !i.setId || typeIds.has(typeKey(i))) continue
        const t = await post<DeviceType>(`/symbol-sets/${i.setId}/device-types`, { name: i.row.type })
        typeIds.set(typeKey(i), t.id)
      }
      // 2. products (accessories are linked afterwards, once every product has an id)
      for (const i of todo) {
        try {
          const r = i.row
          if (i.action === 'create') {
            const typeId = i.typeId ?? typeIds.get(typeKey(i)) ?? null
            await post('/products', {
              kind: typeId ? 'device' : 'accessory', device_type_id: typeId, manufacturer: r.manufacturer, model: r.model, name: r.name,
              spec_url: r.spec_url, unit_cost: r.unit_cost ?? 0, labor_hours: r.labor_hours ?? 0, default_fields: r.default_fields,
            })
          } else if (i.existing) {
            const e = i.existing
            await api(`/products/${e.id}`, { method: 'PUT', body: JSON.stringify({
              ...e, name: r.name || e.name, spec_url: r.spec_url || e.spec_url, unit_cost: r.unit_cost ?? e.unit_cost,
              labor_hours: r.labor_hours ?? e.labor_hours, default_fields: { ...e.default_fields, ...r.default_fields },
            }) })
          }
        } catch { failed++ }
      }
      // 3. accessories, resolved against the fresh catalog
      const fresh = await api<{ products: Product[] }>('/catalog')
      const byKey = new Map(fresh.products.map(p => [productKey(p.manufacturer, p.model), p]))
      for (const i of todo) {
        if (!i.row.accessories.length) continue
        const p = byKey.get(productKey(i.row.manufacturer, i.row.model))
        if (!p) continue
        try {
          await api(`/products/${p.id}`, { method: 'PUT', body: JSON.stringify({ ...p, accessories: resolveAccessories(i.row.accessories, fresh.products, p.id) }) })
        } catch { failed++ }
      }
      setResult(`Imported ${plan.counts.create} new and ${plan.counts.update} updated product${plan.counts.create + plan.counts.update === 1 ? '' : 's'}`
        + (plan.newTypes ? `, ${plan.newTypes} new device type${plan.newTypes === 1 ? '' : 's'}` : '') + (failed ? `; ${failed} failed` : '') + '.')
      setSheets(null)
      onDone()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  const applicable = plan ? plan.counts.create + plan.counts.update : 0
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal wide" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>Import catalog from Excel</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        <p className="muted small">
          Use the sheet "Products" with columns Set, Type, Manufacturer, Model, Name, Spec URL, Unit cost, Labor hours, Accessories ("model x qty; ...")
          and Default fields (JSON). Extra columns become default field values. Rows are matched by manufacturer + model. Leave Set blank for standalone accessories.
          Export the catalog first to get a template.
        </p>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={e => pick(e.target.files?.[0])} />
        {error && <div className="error">{error}</div>}
        {result && <div role="status">{result}</div>}
        {plan && (
          <>
            <p><strong>{fileName}</strong>: {plan.counts.create} new, {plan.counts.update} to update, {plan.counts.unchanged} unchanged, {plan.counts.error} skipped
              {plan.newTypes > 0 && `, ${plan.newTypes} new device type${plan.newTypes === 1 ? '' : 's'} will be created`}</p>
            <div className="diff-list">
              <table className="product-table">
                <thead><tr><th>Row</th><th>Action</th><th>Product</th><th>Details</th></tr></thead>
                <tbody>
                  {plan.items.filter(i => i.action !== 'unchanged').map(i => (
                    <tr key={i.row.row}>
                      <td>{i.row.row}</td>
                      <td className={`diff-${i.action}`}>{ACTION_LABEL[i.action]}</td>
                      <td>{[i.row.set, i.row.type].filter(Boolean).join(' > ')}{i.row.set ? ': ' : ''}{[i.row.manufacturer, i.row.model].filter(Boolean).join(' ') || i.row.name}</td>
                      <td className="small">
                        {i.errors.join('; ')}
                        {i.changes.map(c => <div key={c.field}>{c.field}: <span className="muted">{c.from || '(empty)'}</span> {'→'} {c.to}</div>)}
                        {i.action === 'create' && i.newType && <span className="muted">New type "{i.row.type}"</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row"><span className="spacer" />
              <button className="primary" disabled={!!busy || applicable === 0} onClick={apply}>{busy || `Apply ${applicable} change${applicable === 1 ? '' : 's'}`}</button></div>
          </>
        )}
      </div>
    </div>
  )
}
