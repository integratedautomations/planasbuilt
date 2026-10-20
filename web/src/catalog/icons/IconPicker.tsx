import { useMemo, useState } from 'react'
import { ICON_CATEGORIES, iconDataUrl, iconSvg, searchIcons } from './library'
import type { IconCategory, IconDef } from './library'

interface Props {
  /** Category colour: icons are previewed white on a circle of this colour, the way devices draw them. */
  color: string
  onPick: (dataUrl: string, icon: IconDef) => void
  onClose: () => void
}

/** Searchable, categorised grid of the built-in device icons. Picking one returns it as a data URL. */
export function IconPicker({ color, onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<IconCategory | 'All'>('All')
  const shown = useMemo(() => searchIcons(q, cat), [q, cat])
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
