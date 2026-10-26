import { useEffect, useRef } from 'react'
import { MountBadge } from '../catalog/MountBadge'
import { Icon } from '../ui/Icon'
import { chipLabel } from './chestChips'
import type { ChestOption } from './chestChips'
import type { ToolEntry } from './toolEntries'

interface Props {
  options: ChestOption[]
  chest: ChestOption
  activeId: string
  onChest: (id: string) => void
  onPick: (e: ToolEntry) => void
  /** Opens the full chest list. */
  onMore: () => void
}

function ChipIcon({ e }: { e: ToolEntry }) {
  if (e.mount && e.tool === 'device') return <MountBadge mount={e.mount} color={e.color ?? '#868e96'} src={e.image} size={30} />
  return <span className="chest-chip-icon">{e.icon}</span>
}

/** Phone tool row: a chest picker, then every tool of that chest as an icon + initials chip (one tap switches), and a "more" button for the full list. */
export function ChestRow({ options, chest, activeId, onChest, onPick, onMore }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Scroll only the chip row: scrollIntoView would also slide every scrollable ancestor (the viewport / stage) sideways
    const row = scroller.current
    const el = row?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (!row || !el) return
    const left = el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2
    const max = Math.max(0, row.scrollWidth - row.clientWidth)
    row.scrollTo?.({ left: Math.min(max, Math.max(0, left)) })
  }, [activeId, chest.id])
  return (
    <div className="chest-row-bar" data-no-pan onPointerDown={e => e.stopPropagation()} role="toolbar" aria-label="Tool chest">
      <select className="chest-row-select" aria-label="Tool chest" value={chest.id} onChange={e => onChest(e.target.value)}>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <div className="chest-row-chips" ref={scroller}>
        {chest.entries.map(e => (
          <button key={e.id} type="button" className={`chest-chip${activeId === e.id ? ' active' : ''}`} aria-pressed={activeId === e.id} title={e.label} aria-label={e.label} onClick={() => onPick(e)}>
            <ChipIcon e={e} />
            <span className="chest-chip-text">{chipLabel(e)}</span>
          </button>
        ))}
      </div>
      <button type="button" className="chest-row-more" aria-label="All tools" title="All tools" onClick={onMore}><Icon name="list" size={20} /></button>
    </div>
  )
}
