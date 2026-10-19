import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onClick?: () => void
  disabled?: boolean
  hint?: string
  sub?: MenuItem[]
  separator?: boolean
}

interface Props { x: number; y: number; items: MenuItem[]; onClose: () => void }

/** Floating menu at the cursor with one level of submenus. Closes on Escape, outside click or after a choice. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [open, setOpen] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)), y: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)) })
  }, [x, y])

  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose) }
  }, [onClose])

  const run = (it: MenuItem) => { if (it.disabled || !it.onClick) return; onClose(); it.onClick() }
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} data-no-pan
      onPointerDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
      {items.map((it, i) => it.separator ? <div key={i} className="ctx-sep" role="separator" /> : (
        <div key={i} className="ctx-item-wrap" onMouseEnter={() => setOpen(it.sub ? i : null)}>
          <button role="menuitem" className={`ctx-item${it.sub ? ' has-sub' : ''}`} disabled={it.disabled || (!!it.sub && it.sub.length === 0)}
            aria-haspopup={it.sub ? 'menu' : undefined} onClick={() => (it.sub ? setOpen(i) : run(it))}>
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
            {it.sub && <span aria-hidden>▸</span>}
          </button>
          {it.sub && open === i && it.sub.length > 0 && (
            <div className="ctx-menu ctx-sub" role="menu">
              {it.sub.map((s, j) => s.separator ? <div key={j} className="ctx-sep" role="separator" /> : (
                <button key={j} role="menuitem" className="ctx-item" disabled={s.disabled} onClick={() => run(s)}>
                  <span>{s.label}</span>{s.hint && <kbd>{s.hint}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
