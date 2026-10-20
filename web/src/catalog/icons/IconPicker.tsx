import { useMemo, useState } from 'react'
import { ICON_CLASSES, classForName } from './classIcons'
import { ICON_CATEGORIES, iconDataUrl, iconSvg, searchIcons } from './library'
import type { IconCategory, IconDef } from './library'

interface Props {
  /** Category colour: icons are previewed white on a circle of this colour, the way devices draw them. */
  color: string
  onPick: (dataUrl: string, icon: IconDef) => void
  onClose: () => void
  /** The type being edited: its class is listed first. */
  suggestName?: string
  /** The symbol drawn in the imported .btx, offered as a choice (data URL). */
  original?: string
}

/** Searchable, categorised grid of the built-in device icons. Picking one returns it as a data URL. */
export function IconPicker({ color, onPick, onClose, suggestName, original }: Props) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<IconCategory | 'All'>('All')
  const shown = useMemo(() => searchIcons(q, cat), [q, cat])
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const mine = suggestName ? classForName(suggestName) : undefined
  const classes = ICON_CLASSES.filter(c => (cat === 'All' || c.category === cat) && words.every(w => `${c.name} ${c.id} ${c.category}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(b === mine) - Number(a === mine))
  const pickDef = (i: IconDef) => onPick(iconDataUrl(i), i)
  return (
    <div className="modal-backdrop icon-picker-backdrop" onClick={onClose}>
      <div className="card modal wide icon-picker" role="dialog" aria-label="Choose an icon" onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
        <div className="row"><h3>Choose an icon</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        <input type="search" autoFocus placeholder="Search icons (smoke, camera, card reader...)" aria-label="Search icons" value={q} onChange={e => setQ(e.target.value)} />
        <div className="icon-cats" role="tablist" aria-label="Icon categories">
          {(['All', ...ICON_CATEGORIES] as const).map(c => (
            <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        {original && (
          <div className="icon-grid">
            <button className="icon-cell" title="Original symbol from the .btx" onClick={() => onPick(original, { id: 'btx-original', name: 'Original', category: 'Generic', keywords: '', body: '' })}>
              <span className="set-icon" style={{ background: color }}><img src={original} alt="" /></span>
              <span className="icon-name">Original (from .btx)</span>
            </button>
          </div>
        )}
        {classes.map(c => (
          <div key={c.id} className="icon-class" style={mine === c ? { fontWeight: 600 } : undefined}>
            <span className="icon-name" style={{ minWidth: 190 }}>{c.name}{mine === c ? ' (suggested)' : ''}</span>
            {([['A', c.a], ['B', c.b]] as const).map(([k, i]) => (
              <button key={k} className="icon-cell" title={`${c.name}, option ${k}`} aria-label={`${c.name} option ${k}`} onClick={() => pickDef(i)}>
                <span className="set-icon" style={{ background: color }} dangerouslySetInnerHTML={{ __html: iconSvg(i, '#ffffff') }} />
                <span className="icon-name">Option {k}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="icon-grid">
          {shown.map(i => (
            <button key={i.id} className="icon-cell" title={i.name} aria-label={i.name} onClick={() => onPick(iconDataUrl(i), i)}>
              <span className="set-icon" style={{ background: color }} dangerouslySetInnerHTML={{ __html: iconSvg(i, '#ffffff') }} />
              <span className="icon-name">{i.name}</span>
            </button>
          ))}
          {shown.length === 0 && <p className="muted">No icons match.</p>}
        </div>
      </div>
    </div>
  )
}
