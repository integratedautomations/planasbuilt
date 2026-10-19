import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Layer, Markup, MarkupStyle } from './types'

const SWATCHES = ['#e03131', '#e8590c', '#f59f00', '#2f9e44', '#1971c2', '#7048e8', '#000000', '#868e96']
const STAMPS = ['APPROVED', 'REVISED', 'VOID', 'FIELD VERIFY', 'AS-BUILT', 'NOT IN SCOPE']

interface Props {
  selected: Markup[]
  readOnly: boolean
  /** Style used for new markups when nothing is selected. */
  defaultStyle: MarkupStyle
  onDefaultStyle: (s: MarkupStyle) => void
  stampText: string
  onStampText: (t: string) => void
  /** Updates every selected markup; mergeKey folds slider drags into one undo step. */
  onUpdate: (patch: (m: Markup) => Markup, mergeKey: string) => void
  onDelete: () => void
  layers: Layer[]
  activeLayerId: string | null
  onActiveLayer: (id: string | null) => void
  hidden: Set<string>
  locked: Set<string>
  onToggleHidden: (id: string) => void
  onToggleLocked: (id: string) => void
  onAddLayer: (name: string) => Promise<void>
  textRef: React.RefObject<HTMLTextAreaElement | null>
}

export function SidePanel(p: Props) {
  const [tab, setTab] = useState<'props' | 'layers'>('props')
  return (
    <aside className="side-panel">
      <div className="tabs">
        <button className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>Properties</button>
        <button className={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}>Layers</button>
      </div>
      {tab === 'props' ? <Properties {...p} /> : <Layers {...p} />}
    </aside>
  )
}

function Properties({ selected, readOnly, defaultStyle, onDefaultStyle, stampText, onStampText, onUpdate, onDelete, layers, textRef }: Props) {
  const first = selected[0]
  const style = first?.style ?? defaultStyle
  const disabled = readOnly && !!first
  const setStyle = (patch: Partial<MarkupStyle>, key: string) => {
    if (first) onUpdate(m => ({ ...m, style: { ...m.style, ...patch } }), `style.${key}`)
    else onDefaultStyle({ ...defaultStyle, ...patch })
  }
  const hasText = first && (first.type === 'text' || first.type === 'stamp')

  return (
    <div className="panel-body">
      <div className="panel-heading">
        {first ? `${selected.length > 1 ? `${selected.length} markups` : labelFor(first.type)}` : 'New markup style'}
      </div>
      <fieldset disabled={disabled} className="stack">
        <label className="field">Color
          <div className="swatches">
            {SWATCHES.map(c => (
              <button key={c} className={`swatch${style.stroke === c ? ' on' : ''}`} style={{ background: c }}
                aria-label={c} onClick={() => setStyle({ stroke: c }, 'stroke')} />
            ))}
            <input type="color" value={style.stroke || '#000000'} onChange={e => setStyle({ stroke: e.target.value }, 'stroke')} />
          </div>
        </label>
        <label className="field">Fill
          <div className="swatches">
            <button className={`swatch none${!style.fill ? ' on' : ''}`} aria-label="No fill" onClick={() => setStyle({ fill: '' }, 'fill')} />
            {SWATCHES.slice(0, 6).map(c => (
              <button key={c} className={`swatch${style.fill === c ? ' on' : ''}`} style={{ background: c }}
                aria-label={`fill ${c}`} onClick={() => setStyle({ fill: c }, 'fill')} />
            ))}
            <input type="color" value={style.fill || '#ffffff'} onChange={e => setStyle({ fill: e.target.value }, 'fill')} />
          </div>
        </label>
        <label className="field">Line width <span className="muted">{style.strokeWidth}</span>
          <input type="range" min={0.5} max={20} step={0.5} value={style.strokeWidth}
            onChange={e => setStyle({ strokeWidth: +e.target.value }, 'strokeWidth')} />
        </label>
        <label className="field">Opacity <span className="muted">{Math.round(style.opacity * 100)}%</span>
          <input type="range" min={0.1} max={1} step={0.05} value={style.opacity}
            onChange={e => setStyle({ opacity: +e.target.value }, 'opacity')} />
        </label>
        <label className="field">Font size <span className="muted">{style.fontSize}</span>
          <input type="range" min={6} max={96} step={1} value={style.fontSize}
            onChange={e => setStyle({ fontSize: +e.target.value }, 'fontSize')} />
        </label>
        <label className="check"><input type="checkbox" checked={!!style.dash}
          onChange={e => setStyle({ dash: e.target.checked }, 'dash')} /> Dashed line</label>

        {hasText && selected.length === 1 && (
          <label className="field">{first.type === 'stamp' ? 'Stamp text' : 'Text'}
            <textarea ref={textRef} rows={3} value={first.text}
              onChange={e => onUpdate(m => ({ ...m, text: e.target.value }), `text.${first.id}`)} />
          </label>
        )}
        {(!first || first.type === 'stamp') && (
          <label className="field">{first ? 'Preset' : 'Stamp'}
            <select value={first ? '' : stampText} onChange={e => {
              if (!e.target.value) return
              if (first) onUpdate(m => ({ ...m, text: e.target.value }), `text.${first.id}`)
              else onStampText(e.target.value)
            }}>
              {first && <option value="">Choose…</option>}
              {STAMPS.map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
        )}
        {first && (
          <label className="field">Layer
            <select value={first.layer_id ?? ''} onChange={e => onUpdate(m => ({ ...m, layer_id: e.target.value || null }), 'layer')}>
              <option value="">Default</option>
              {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        {first && !readOnly && <button className="danger" onClick={onDelete}>Delete {selected.length > 1 ? `${selected.length} markups` : 'markup'}</button>}
      </fieldset>
    </div>
  )
}

function Layers({ layers, activeLayerId, onActiveLayer, hidden, locked, onToggleHidden, onToggleLocked, onAddLayer, readOnly }: Props) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const all = [{ id: '', name: 'Default', color: '#868e96' }, ...layers]

  async function add(e: FormEvent) {
    e.preventDefault()
    try { await onAddLayer(name); setName(''); setError('') } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="panel-body">
      <div className="panel-heading">Layers</div>
      <p className="muted small">The selected layer gets new markups.</p>
      <ul className="layer-list">
        {all.map(l => (
          <li key={l.id} className={(activeLayerId ?? '') === l.id ? 'active' : ''}>
            <button className="layer-name" onClick={() => onActiveLayer(l.id || null)}>
              <span className="dot" style={{ background: l.color }} />{l.name}
            </button>
            <button className="icon-btn small" title={hidden.has(l.id) ? 'Show' : 'Hide'} onClick={() => onToggleHidden(l.id)}>
              {hidden.has(l.id) ? '◌' : '●'}
            </button>
            <button className="icon-btn small" title={locked.has(l.id) ? 'Unlock' : 'Lock'} onClick={() => onToggleLocked(l.id)}>
              {locked.has(l.id) ? '🔒' : '🔓'}
            </button>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <form className="row" onSubmit={add}>
          <input placeholder="New layer" value={name} onChange={e => setName(e.target.value)} required />
          <button>Add</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

function labelFor(t: Markup['type']) {
  return ({ rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', highlight: 'Highlight', text: 'Text box', stamp: 'Stamp',
    line: 'Line', arrow: 'Arrow', polyline: 'Polyline', polygon: 'Polygon', freehand: 'Pen' } as const)[t]
}
