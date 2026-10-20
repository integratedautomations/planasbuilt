import { Fragment, useState } from 'react'
import { api, post } from '../api'
import type { SymbolSet } from '../markups/types'
import { parseBtxSet } from './btx'
import type { BtxTool } from './btx'
import { autoIconFor } from './icons/classIcons'
import { IconPicker } from './icons/IconPicker'
import { shrinkImage } from './readIcon'
import type { CatalogData, DeviceType } from './types'

interface Row {
  file: string
  tool: BtxTool
  include: boolean
  name: string
  prefix: string
  /** existing symbol set id, or "new:<name>" */
  setKey: string
  typeId: string
  /** Icon to store: the tool's own drawing, else the matching class's option A, else none. */
  icon: string
}

const NEW = 'new:'
const lc = (s: string) => s.trim().toLowerCase()
const stripNew = (t: string) => t.replace(/^new\s+/i, '').replace(/\s+/g, ' ').trim()
const initials = (name: string) => (name.split(/\s+/).map(w => w[0]).join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3) || 'X')
const cleanPrefix = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * Converts one or more Bluebeam Revu tool sets (.btx) into device types: each tool becomes a row with its drawn icon,
 * name, tag prefix (the tool's label) and a set suggested from the tool's layer / the file's title. See catalog/btx.ts.
 */
export function BtxImport({ data, sets, onClose, onDone }: { data: CatalogData; sets: SymbolSet[]; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState<number | null>(null)

  const typesIn = (setKey: string) => setKey.startsWith(NEW) ? [] : data.device_types.filter(t => t.symbol_set_id === setKey)
  const match = (setKey: string, name: string) => typesIn(setKey).find(t => lc(t.name) === lc(name))?.id ?? ''
  const findSet = (name: string) => sets.find(s => lc(s.name) === lc(name))

  async function pick(files: FileList | null) {
    if (!files || !files.length) return
    setError(''); setResult('')
    const out: Row[] = []
    const bad: string[] = []
    for (const file of Array.from(files)) {
      try {
        const { title, tools } = await parseBtxSet(await file.text())
        if (!tools.length) { bad.push(file.name); continue }
        const fallback = stripNew(title) || file.name.replace(/\.[^.]+$/, '')
        for (const tool of tools) {
          const existing = (tool.layer && findSet(tool.layer)) || findSet(fallback)
          const setKey = existing ? existing.id : NEW + fallback
          const name = tool.name || tool.subject || tool.title
          out.push({ file: file.name, tool, include: true, name, prefix: cleanPrefix(tool.label ?? ''), setKey, typeId: match(setKey, name), icon: tool.icon ?? autoIconFor(tool.name || tool.subject || tool.title) ?? '' })
        }
      } catch { bad.push(file.name) }
    }
    if (bad.length) setError(`No tools were recognised in: ${bad.join(', ')}. They may not be Revu tool sets, or use a layout this reader does not know.`)
    setRows(out.length ? out : null)
  }

  const patch = (i: number, p: Partial<Row>) => setRows(rs => rs && rs.map((r, j) => (j === i ? { ...r, ...p } : r)))

  /** Every "new set" proposed by the rows (offered in each row's Set menu). */
  const newSets = [...new Set((rows ?? []).map(r => r.setKey).filter(k => k.startsWith(NEW)))]

  async function apply() {
    if (!rows) return
    setBusy(true); setError('')
    let created = 0, linked = 0, failed = 0, newSetCount = 0
    const made: Record<string, string> = {}
    for (const r of rows) {
      if (!r.include || !r.name.trim()) continue
      try {
        let setId = r.setKey
        if (setId.startsWith(NEW)) {
          const nm = setId.slice(NEW.length)
          if (!made[nm]) {
            const s = await post<SymbolSet>('/symbol-sets', { name: nm, tag_prefix: initials(nm), color: '#868e96', icon: '', fields: [], has_fov: false })
            made[nm] = s.id; newSetCount++
          }
          setId = made[nm]
        }
        let icon = r.icon
        if (icon && !icon.startsWith('data:image/svg+xml')) icon = await shrinkImage(icon).catch(() => '')
        const existing = r.typeId && !r.setKey.startsWith(NEW) ? data.device_types.find(x => x.id === r.typeId) : undefined
        if (existing) {
          const next = { ...existing, icon: existing.icon || icon, tag_prefix: existing.tag_prefix || r.prefix || null }
          if (next.icon !== existing.icon || next.tag_prefix !== existing.tag_prefix) await api<DeviceType>(`/device-types/${existing.id}`, { method: 'PUT', body: JSON.stringify(next) })
          linked++
        } else {
          await post<DeviceType>(`/symbol-sets/${setId}/device-types`, { name: r.name.trim(), icon, tag_prefix: r.prefix || null })
          created++
        }
      } catch { failed++ }
    }
    setResult(`Created ${created} device type${created === 1 ? '' : 's'}${newSetCount ? ` and ${newSetCount} set${newSetCount === 1 ? '' : 's'}` : ''}, matched ${linked} existing${failed ? `, ${failed} failed` : ''}.`)
    setRows(null)
    setBusy(false)
    onDone()
  }

  const chosen = (rows ?? []).filter(r => r.include && r.name.trim()).length
  const fileNames = [...new Set((rows ?? []).map(r => r.file))]
  return (
    <>
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal xwide" onClick={e => e.stopPropagation()}>
        <div className="row"><h3>Import Revu tool set (.btx)</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        <p className="muted small">
          Reads each tool name, tag label, layer and drawing (shown as an SVG icon). The set is suggested from the layer or the tool set title; sets that do not exist yet are created.
          You can choose several .btx files at once.
        </p>
        <input type="file" accept=".btx,.xml" multiple onChange={e => { void pick(e.target.files); e.target.value = '' }} />
        {error && <div className="error">{error}</div>}
        {result && <div role="status">{result}</div>}
        {rows && (
          <>
            <div className="table-scroll diff-list">
              <table className="product-table btx-table">
                <thead><tr><th className="c-chk" /><th className="c-icon">Icon</th><th>Device type name</th><th className="c-pfx">Tag prefix</th><th>Set</th><th>Existing type</th></tr></thead>
                <tbody>
                  {fileNames.map(fn => (
                    <Fragment key={fn}>
                      {fileNames.length > 1 && <tr className="btx-group"><td colSpan={6}>{fn}</td></tr>}
                      {rows.map((r, i) => r.file !== fn ? null : (
                        <tr key={i}>
                          <td className="c-chk"><input type="checkbox" aria-label="Import" checked={r.include} onChange={e => patch(i, { include: e.target.checked })} /></td>
                          <td className="c-icon"><button type="button" title="Change icon" aria-label={`Change icon for ${r.name}`} onClick={() => setPicking(i)}>
                            {r.icon ? <img src={r.icon} alt="" width={36} height={36} style={r.icon !== r.tool.icon ? { background: '#868e96', borderRadius: 6 } : undefined} /> : <span className="muted">Pick</span>}</button></td>
                          <td>
                            <input value={r.name} onChange={e => patch(i, { name: e.target.value, typeId: match(r.setKey, e.target.value) })} />
                            {r.tool.model && <div className="muted small">Model: {r.tool.model}</div>}
                          </td>
                          <td className="c-pfx"><input value={r.prefix} aria-label="Tag prefix" onChange={e => patch(i, { prefix: cleanPrefix(e.target.value) })} /></td>
                          <td>
                            <select value={r.setKey} onChange={e => patch(i, { setKey: e.target.value, typeId: match(e.target.value, r.name) })}>
                              {sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                              {newSets.map(k => <option key={k} value={k}>New set: {k.slice(NEW.length)}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.typeId} onChange={e => patch(i, { typeId: e.target.value })}>
                              <option value="">New type</option>
                              {typesIn(r.setKey).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
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
      {picking !== null && rows && rows[picking] && (
        <IconPicker color="#868e96" suggestName={rows[picking].name} original={rows[picking].tool.icon}
          onClose={() => setPicking(null)} onPick={url => { patch(picking, { icon: url }); setPicking(null) }} />
      )}
    </>
  )
}
