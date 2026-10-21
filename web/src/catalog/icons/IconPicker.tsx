import { useMemo, useState } from 'react'
import { MountBadge } from '../MountBadge'
import type { Mount } from '../../markups/mount'
import { classForName, searchClasses } from './classIcons'
import { ICON_CATEGORIES, iconDataUrl } from './library'
import type { IconCategory, IconDef } from './library'

interface Props {
  /** Category colour: icons are previewed white inside the mount shape in this colour, the way devices draw them. */
  color: string
  /** Container shape the icons are previewed in (default ceiling = circle). */
  mount?: Mount
  onPick: (dataUrl: string, icon: IconDef) => void
  onClose: () => void
  /** The type being edited: its class is listed first. */
  suggestName?: string
  /** The symbol drawn in the imported .btx, offered as a choice (data URL). */
  original?: string
}

/** Searchable, categorised list of the built-in device icons (two options per device). Picking one returns it as a data URL. */
export function IconPicker({ color, mount = 'ceiling', onPick, onClose, suggestName, original }: Props) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<IconCategory | 'All'>('All')
  const mine = suggestName ? classForName(suggestName) : undefined
  const classes = useMemo(() => {
    const l = searchClasses(q, cat)
    return mine && l.includes(mine) ? [mine, ...l.filter(c => c !== mine)] : l
  }, [q, cat, mine])
  const pickDef = (i: IconDef) => onPick(iconDataUrl(i), i)
  return (
    <div className="modal-backdrop icon-picker-backdrop" onClick={onClose}>
      <div className="card modal wide icon-picker" role="dialog" aria-label="Choose an icon" onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
        <div className="row"><h3>Choose an icon</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        <input type="search" autoFocus placeholder="Search icons (smoke, camera, card reader, rex...)" aria-label="Search icons" value={q} onChange={e => setQ(e.target.value)} />
        <div className="icon-cats" role="tablist" aria-label="Icon categories">
          {(['All', ...ICON_CATEGORIES] as const).map(c => (
            <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        {original && (
          <div className="icon-grid">
            <button className="icon-cell" title="Original symbol from the .btx" onClick={() => onPick(original, { id: 'btx-original', name: 'Original', category: 'General', keywords: '', body: '' })}>
              <MountBadge mount={mount} color={color} src={original} size={40} />
              <span className="icon-name">Original (from .btx)</span>
            </button>
          </div>
        )}
        {classes.map(c => (
          <div key={c.id} className="icon-class" style={mine === c ? { fontWeight: 600 } : undefined}>
            <span className="icon-name" style={{ minWidth: 190 }}>{c.name}{mine === c ? ' (suggested)' : ''}</span>
            {([['A', c.a], ['B', c.b]] as const).map(([k, i]) => (
              <button key={k} className="icon-cell" title={`${c.name}, option ${k}`} aria-label={`${c.name} option ${k}`} onClick={() => pickDef(i)}>
                <MountBadge mount={mount} color={color} src={iconDataUrl(i)} size={40} />
                <span className="icon-name">Option {k}</span>
              </button>
            ))}
          </div>
        ))}
        {classes.length === 0 && <p className="muted">No icons match.</p>}
      </div>
    </div>
  )
}
