import { useState } from 'react'
import type { ReactNode } from 'react'
import { legendFields, legendItems, legendSettings, LEGEND_COLUMNS, LEGEND_SORTS, moveManual } from './legend'
import type { LegendAlign, LegendColumn, LegendRow, LegendSettings, LegendSort } from './legend'
import { saveLegendPreset } from '../legend/presets'
import type { Markup, SymbolSet } from './types'

interface Props {
  m: Markup
  readOnly: boolean
  onUpdate: (patch: (m: Markup) => Markup, mergeKey: string) => void
  onDelete: () => void
  /** Areas on this page, for the "counts devices on" choice. */
  pageAreas: Markup[]
  symbolSets: Map<string, SymbolSet>
  /** Live rows of this legend (for manual ordering). */
  rows: LegendRow[]
  /** Layer picker, supplied by the side panel. */
  children?: ReactNode
}

/** Everything a legend can be set up with: scope, grouping, sort, columns (order, width, alignment), sets, and saving it as a preset. */
export function LegendPanel({ m, readOnly, onUpdate, onDelete, pageAreas, symbolSets, rows, children }: Props) {
  const s = legendSettings(m)
  const set = (patch: Partial<LegendSettings>, key: string) =>
    onUpdate(x => ({ ...x, fields: { ...(x.fields ?? {}), ...legendFields({ ...legendSettings(x), ...patch }) } }), `legend.${key}`)
  const areaName = (a: Markup) => a.text.trim() || (a.fields?.sheet === true ? 'Sheet' : 'Unnamed area')
  const sets = [...symbolSets.values()].sort((a, b) => a.sort - b.sort)
  const [presetName, setPresetName] = useState('')
  const [presetSet, setPresetSet] = useState('')
  const [note, setNote] = useState('')

  /** Columns in display order, then the ones that are off. */
  const toggleColumn = (c: LegendColumn, on: boolean) => {
    const next = on ? [...s.columns, c] : s.columns.filter(x => x !== c)
    if (next.length) set({ columns: next }, 'columns')
  }
  const moveColumn = (c: LegendColumn, dir: -1 | 1) => set({ columns: moveManual(s.columns, c, dir) as LegendColumn[] }, 'columns')
  const setWidth = (c: LegendColumn, v: number) => {
    const widths = { ...s.widths }
    if (v > 0) widths[c] = v; else delete widths[c]
    set({ widths }, 'widths')
  }
  const setAlign = (c: LegendColumn, a: LegendAlign | '') => {
    const aligns = { ...s.aligns }
    if (a) aligns[c] = a; else delete aligns[c]
    set({ aligns }, 'aligns')
  }

  // Manual order: the keys as currently shown (rows only, headers skipped)
  const shownKeys = legendItems(rows, s).flatMap(i => (i.kind === 'row' ? [i.row.key] : []))
  const moveRow = (key: string, dir: -1 | 1) => set({ sort: 'manual', manual: moveManual(shownKeys, key, dir) }, 'manual')

  const savePreset = async () => {
    const name = presetName.trim()
    if (!name) return
    setNote('')
    try {
      await saveLegendPreset(name, s, presetSet || null)
      setPresetName('')
      setNote(`Saved. Find "${name}" in the Tool chest under ${presetSet ? symbolSets.get(presetSet)?.name ?? 'its symbol set' : 'Legends'}.`)
    } catch (e) { setNote((e as Error).message || 'Could not save the preset') }
  }

  return (
    <div className="panel-body">
      <div className="panel-heading">Legend</div>
      <fieldset disabled={readOnly} className="stack">
        <label className="field">Title
          <input value={s.title} placeholder="No title" onChange={e => set({ title: e.target.value }, 'title')} />
        </label>
        <label className="field">Counts devices on
          <select value={s.scope} onChange={e => set({ scope: e.target.value }, 'scope')}>
            <option value="sheet">This sheet</option>
            <option value="document">Whole document</option>
            {pageAreas.map(a => <option key={a.id} value={`area:${a.id}`}>Area: {areaName(a)}</option>)}
            {s.scope.startsWith('area:') && !pageAreas.some(a => `area:${a.id}` === s.scope) && <option value={s.scope}>Area (other sheet)</option>}
          </select>
        </label>
        <label className="field">Group rows by
          <select value={s.groupBy} onChange={e => set({ groupBy: e.target.value as LegendSettings['groupBy'] }, 'group')}>
            <option value="type">Device type</option>
            <option value="product">Product</option>
            <option value="type+product">Device type + product</option>
          </select>
        </label>
        <label className="field">Sort by
          <select value={s.sort} onChange={e => set({ sort: e.target.value as LegendSort }, 'sort')}>
            {LEGEND_SORTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={s.groupBySet} onChange={e => set({ groupBySet: e.target.checked }, 'groupBySet')} /> Sub-headers per symbol set</label>
        <label className="check"><input type="checkbox" checked={s.showZero} onChange={e => set({ showZero: e.target.checked }, 'showZero')} /> Show types with a zero count</label>

        {sets.length > 1 && (
          <div className="field">Include symbol sets
            <div className="stack">
              {sets.map(x => (
                <label key={x.id} className="check">
                  <input type="checkbox" checked={!s.setIds.length || s.setIds.includes(x.id)} onChange={e => {
                    const cur = s.setIds.length ? s.setIds : sets.map(y => y.id)
                    const next = e.target.checked ? [...cur, x.id] : cur.filter(id => id !== x.id)
                    set({ setIds: next.length === sets.length ? [] : next.length ? next : cur }, 'sets')
                  }} /> {x.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="field">Columns (top to bottom = left to right)
          <div className="stack">
            {s.columns.map((c, i) => (
              <div key={c} className="row" style={{ gap: 4, alignItems: 'center' }}>
                <label className="check grow" style={{ minWidth: 0 }}>
                  <input type="checkbox" checked onChange={() => toggleColumn(c, false)} /> {LEGEND_COLUMNS.find(x => x.key === c)?.label}
                </label>
                {c !== 'icon' && (
                  <>
                    <input type="number" min={0} step={0.5} style={{ width: 52 }} aria-label={`${c} width`} title="Relative width (blank = automatic)"
                      value={s.widths[c] ?? ''} placeholder="auto" onChange={e => setWidth(c, Number(e.target.value))} />
                    <select aria-label={`${c} alignment`} value={s.aligns[c] ?? ''} onChange={e => setAlign(c, e.target.value as LegendAlign | '')}>
                      <option value="">Auto</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                    </select>
                  </>
                )}
                <button type="button" aria-label={`Move ${c} up`} disabled={i === 0} onClick={() => moveColumn(c, -1)}>↑</button>
                <button type="button" aria-label={`Move ${c} down`} disabled={i === s.columns.length - 1} onClick={() => moveColumn(c, 1)}>↓</button>
              </div>
            ))}
            {LEGEND_COLUMNS.filter(c => !s.columns.includes(c.key)).map(c => (
              <label key={c.key} className="check"><input type="checkbox" checked={false} onChange={() => toggleColumn(c.key, true)} /> {c.label}</label>
            ))}
          </div>
        </div>

        {s.sort === 'manual' && shownKeys.length > 0 && (
          <div className="field">Row order
            <div className="stack">
              {rows.length > 0 && shownKeys.map((k, i) => (
                <div key={k} className="row" style={{ gap: 4, alignItems: 'center' }}>
                  <span className="grow ellipsis">{rows.find(r => r.key === k)?.name}</span>
                  <button type="button" aria-label="Move row up" disabled={i === 0} onClick={() => moveRow(k, -1)}>↑</button>
                  <button type="button" aria-label="Move row down" disabled={i === shownKeys.length - 1} onClick={() => moveRow(k, 1)}>↓</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <label className="field">Text size
          <input type="range" min={8} max={28} value={m.style.fontSize} onChange={e => onUpdate(x => ({ ...x, style: { ...x.style, fontSize: Number(e.target.value) } }), 'legend.font')} />
        </label>

        <div className="field">Save these settings as a preset
          <div className="stack">
            <input value={presetName} placeholder="Preset name" maxLength={80} onChange={e => setPresetName(e.target.value)} />
            <select aria-label="Attach to symbol set" value={presetSet} onChange={e => setPresetSet(e.target.value)}>
              <option value="">Show under Legends</option>
              {sets.map(x => <option key={x.id} value={x.id}>Attach to {x.name}</option>)}
            </select>
            <button type="button" disabled={!presetName.trim()} onClick={() => { void savePreset() }}>Save preset</button>
            {note && <div className="muted small">{note}</div>}
          </div>
        </div>
      </fieldset>
      <p className="muted small">The table updates as devices are placed. Drag the side handles to change its width; the height follows the rows.</p>
      {children}
      {!readOnly && <button className="danger" onClick={onDelete}>Delete legend</button>}
    </div>
  )
}
