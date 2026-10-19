import { useState } from 'react'
import { groupEntries, matchesSearch } from './toolEntries'
import type { ToolEntry } from './toolEntries'
import { reorderFavorites } from '../prefs/prefs'

interface Props {
  entries: ToolEntry[]
  activeId: string
  favorites: string[]
  recent: string[]
  hotkeys: Record<string, string>
  readOnly: boolean
  onPick: (e: ToolEntry) => void
  onFavorites: (ids: string[]) => void
  onToggleFavorite: (id: string) => void
}

function EntryIcon({ e }: { e: ToolEntry }) {
  if (e.image) return <span className="set-icon" style={{ background: e.color }}><img src={e.image} alt="" /></span>
  return <span className="chest-icon">{e.icon}</span>
}

/** Toolbox-style tool list: favorites bar, recent tools, then every tool grouped. Searchable. */
export function ToolChest(p: Props) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const byId = new Map(p.entries.map(e => [e.id, e]))
  const allowed = (e: ToolEntry) => !p.readOnly || e.tool === 'select' || e.tool === 'pan'
  const favs = p.favorites.map(id => byId.get(id)).filter((e): e is ToolEntry => !!e && allowed(e))
  const recent = p.recent.map(id => byId.get(id)).filter((e): e is ToolEntry => !!e && allowed(e))
  const searching = q.trim() !== ''
  const groups = groupEntries(p.entries.filter(allowed)).map(g => ({ ...g, entries: g.entries.filter(e => matchesSearch(e, q)) })).filter(g => g.entries.length)
  const keyOf = (e: ToolEntry) => (e.command && p.hotkeys[e.command]) || ''

  const row = (e: ToolEntry, opts: { drag?: boolean } = {}) => {
    const isFav = p.favorites.includes(e.id)
    return (
      <div key={e.id} className={`chest-row${p.activeId === e.id ? ' active' : ''}${dragId === e.id ? ' dragging' : ''}`}
        draggable={opts.drag} title={`${e.label}${keyOf(e) ? ` (${keyOf(e)})` : ''} - right-click to ${isFav ? 'unpin' : 'pin'}`}
        onDragStart={opts.drag ? ev => { setDragId(e.id); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', e.id) } : undefined}
        onDragOver={opts.drag ? ev => { if (dragId) ev.preventDefault() } : undefined}
        onDrop={opts.drag ? ev => { ev.preventDefault(); if (dragId) p.onFavorites(reorderFavorites(p.favorites, dragId, e.id)); setDragId(null) } : undefined}
        onDragEnd={() => setDragId(null)}
        onContextMenu={ev => { ev.preventDefault(); p.onToggleFavorite(e.id) }}>
        <button className="chest-pick" aria-pressed={p.activeId === e.id} onClick={() => p.onPick(e)}>
          <EntryIcon e={e} />
          <span className="chest-label">{e.label}</span>
          {keyOf(e) && <kbd className="chest-key">{keyOf(e)}</kbd>}
        </button>
        <button className={`chest-star${isFav ? ' on' : ''}`} aria-label={isFav ? `Unpin ${e.label}` : `Pin ${e.label} to favorites`} aria-pressed={isFav}
          onClick={() => p.onToggleFavorite(e.id)}>{isFav ? '★' : '☆'}</button>
      </div>
    )
  }

  return (
    <div className="tool-chest">
      <input type="search" className="chest-search" placeholder="Search tools" aria-label="Search tools" value={q} onChange={e => setQ(e.target.value)} />
      <div className="chest-scroll">
        {!searching && (
          <section aria-label="Favorites">
            <div className="chest-heading">Favorites</div>
            {favs.length === 0 && <div className="muted small chest-empty">Click a star to pin a tool here. Drag to reorder.</div>}
            <div className="chest-favs"
              onDragOver={ev => { if (dragId) ev.preventDefault() }}
              onDrop={ev => { if (ev.target === ev.currentTarget && dragId) { ev.preventDefault(); p.onFavorites(reorderFavorites(p.favorites, dragId, null)); setDragId(null) } }}>
              {favs.map(e => row(e, { drag: true }))}
            </div>
          </section>
        )}
        {!searching && recent.length > 0 && (
          <section aria-label="Recent tools">
            <div className="chest-heading">Recent</div>
            {recent.map(e => row(e))}
          </section>
        )}
        {groups.map(g => {
          const open = searching || !collapsed.has(g.name)
          return (
            <section key={g.name} aria-label={g.name}>
              <button className="chest-heading chest-group" aria-expanded={open}
                onClick={() => setCollapsed(prev => { const n = new Set(prev); if (n.has(g.name)) n.delete(g.name); else n.add(g.name); return n })}>
                <span aria-hidden>{open ? '▾' : '▸'}</span> {g.name}{g.isSet && <span className="muted small"> (symbols)</span>}
              </button>
              {open && g.entries.map(e => row(e))}
            </section>
          )
        })}
        {searching && groups.length === 0 && <div className="muted small chest-empty">No tools match.</div>}
      </div>
    </div>
  )
}
