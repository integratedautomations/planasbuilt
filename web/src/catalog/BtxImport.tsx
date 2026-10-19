import { useState } from 'react'
import { api, post } from '../api'
import type { SymbolSet } from '../markups/types'
import { parseBtx } from './btx'
import type { BtxTool } from './btx'
import { shrinkImage } from './readIcon'
import type { CatalogData, DeviceType } from './types'

interface Mapping { include: boolean; name: string; setId: string; typeId: string }

/**
 * Converts a Bluebeam Revu tool set (.btx) into device types: lists every tool found, the admin picks the set
 * and a new or existing device type for each. Best effort: see catalog/btx.ts for what is and is not read.
 */
export function BtxImport({ data, sets, onClose, onDone }: { data: CatalogData; sets: SymbolSet[]; onClose: () => void; onDone: () => void }) {
  const [tools, setTools] = useState<BtxTool[] | null>(null)
  const [maps, setMaps] = useState<Mapping[]>([])
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)

  const typesIn = (setId: string) => data.device_types.filter(t => t.symbol_set_id === setId)
  const match = (setId: string, name: string) => typesIn(setId).find(t => t.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? ''

  async function pick(file: File | undefined) {
    if (!file) return
    setError(''); setResult('')
    try {
      const found = await parseBtx(await file.text())
      if (!found.length) { setError('No tools were recognised in that file. It may not be a Revu tool set, or uses a layout this reader does not know.'); setTools(null); return }
      const setId = sets[0]?.id ?? ''
      setTools(found)
      setMaps(found.map(t => { const name = t.subject || t.title; return { include: true, name, setId, typeId: match(setId, name) } }))
    } catch (e) { setError(`Could not read that file: ${(e as Error).message}`) }
  }

  const patch = (i: number, p: Partial<Mapping>) => setMaps(ms => ms.map((m, j) => (j === i ? { ...m, ...p } : m)))

  async function apply() {
    if (!tools) return
    setBusy(true); setError('')
    let created = 0, linked = 0, failed = 0
    for (let i = 0; i < tools.length; i++) {
      const m = maps[i]
      if (!m.include || !m.setId || !m.name.trim()) continue
      try {
        const icon = tools[i].icon ? await shrinkImage(tools[i].icon!).catch(() => '') : ''
        if (m.typeId) {
          // existing type: fill in its icon when it has none
          const t = data.device_types.find(x => x.id === m.typeId)
          if (t && !t.icon && icon) await api<DeviceType>(`/device-types/${t.id}`, { method: 'PUT', body: JSON.stringify({ ...t, icon }) })
          linked++
        } else {
          await post<DeviceType>(`/symbol-sets/${m.setId}/device-types`, { name: m.name.trim(), icon })
          created++
        }
      } catch { failed++ }
    }
    setResult(`Created ${created} device type${created === 1 ? '' : 's'}, matched ${linked} existing${failed ? `, ${failed} failed` : ''}.`)
    setTools(null)
    setBusy(false)
    onDone()
  }

  const chosen = maps.filter(m => m.include && m.setId && m.name.trim()).length
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal wide" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>Import Revu tool set (.btx)</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        <p className="muted small">
          Best effort. Reads each tool's name, its markup Subject and an embedded icon when present. Colors, line styles and custom columns are not imported.
          Choose the set and device type for each tool; new device types are created with the Subject as their name.
        </p>
        <input type="file" accept=".btx,.xml" onChange={e => pick(e.target.files?.[0])} />
        {error && <div className="error">{error}</div>}
        {result && <div role="status">{result}</div>}
        {tools && (
          <>
            <div className="table-scroll diff-list">
              <table className="product-table">
                <thead><tr><th /><th>Icon</th><th>Revu tool</th><th>Device type name</th><th>Set</th><th>Existing type</th></tr></thead>
                <tbody>
                  {tools.map((t, i) => (
                    <tr key={i}>
                      <td><input type="checkbox" aria-label="Import" checked={maps[i].include} onChange={e => patch(i, { include: e.target.checked })} /></td>
                      <td>{t.icon ? <img src={t.icon} alt="" width={24} height={24} /> : <span className="muted">-</span>}</td>
                      <td>{t.title}{t.subject && t.subject !== t.title && <div className="muted small">Subject: {t.subject}</div>}{!t.decoded && <div className="muted small">Markup data not decoded</div>}</td>
                      <td><input value={maps[i].name} onChange={e => patch(i, { name: e.target.value, typeId: match(maps[i].setId, e.target.value) })} /></td>
                      <td>
                        <select value={maps[i].setId} onChange={e => patch(i, { setId: e.target.value, typeId: match(e.target.value, maps[i].name) })}>
                          {sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={maps[i].typeId} onChange={e => patch(i, { typeId: e.target.value })}>
                          <option value="">New type</option>
                          {typesIn(maps[i].setId).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row"><span className="spacer" />
              <button className="primary" disabled={busy || chosen === 0} onClick={apply}>{busy ? 'Importing…' : `Import ${chosen} tool${chosen === 1 ? '' : 's'}`}</button></div>
          </>
        )}
      </div>
    </div>
  )
}
