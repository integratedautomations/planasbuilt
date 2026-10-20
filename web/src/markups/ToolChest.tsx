import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { entryCommand, groupEntries, matchesSearch } from './toolEntries'
import type { ToolEntry } from './toolEntries'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { reorderFavorites } from '../prefs/prefs'
import { groupPrefs, hiddenGroupCount, ICON_PX, moveGroup, moveItem, orderBy, resetChestOrder, setGroup, showAllGroups } from '../prefs/chest'
import type { ChestPrefs, ChestSize } from '../prefs/chest'

interface Props {
  entries: ToolEntry[]
  activeId: string
  favorites: string[]
  recent: string[]
  hotkeys: Record<string, string>
  readOnly: boolean
  chest: ChestPrefs
  onChest: (c: ChestPrefs) => void
  onPick: (e: ToolEntry) => void
  onFavorites: (ids: string[]) => void
  onToggleFavorite: (id: string) => void
  /** Opens the hotkey recorder for an entry. */
  onAssignHotkey: (e: ToolEntry) => void
  onRemoveHotkey: (e: ToolEntry) => void
  /** Admins only: opens the device-type editor for a device-type entry. Omit to hide the menu item. */
  onEditType?: (e: ToolEntry) => void
  /** Admins only: opens the device-type editor in create mode for a symbol set. Omit to hide the menu items and "+" button. */
  onAddType?: (setId: string) => void
}

function EntryIcon({ e, px }: { e: ToolEntry; px?: number }) {
  const size = px ? { width: px + 8, height: px + 8 } : undefined
  if (e.image) return <span className="set-icon" style={{ background: e.color, ...size }}><img src={e.image} alt="" /></span>
  return <span className="chest-icon" style={px ? { ['--chest-icon' as string]: `${px}px` } : undefined}>{e.icon}</span>
}

/** Below this zone width the chest becomes an icon strip. */
export const STRIP_WIDTH = 140

type Drag = { kind: 'fav' | 'item' | 'group'; id: string; group?: string }

/** Toolbox-style tool list: favorites bar, recent tools, then every tool grouped. Searchable; groups and items can be reordered by dragging. */
export function ToolChest(p: Props) {
  const [q, setQ] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < STRIP_WIDTH))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  /** Groups the user opened or closed this session (otherwise the saved "start expanded" setting applies). */
  const [openNow, setOpenNow] = useState<Record<string, boolean>>({})
  const [drag, setDrag] = useState<Drag | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; group: string } | null>(null)
  const [itemMenu, setItemMenu] = useState<{ x: number; y: number; entry: ToolEntry } | null>(null)
  const byId = new Map(p.entries.map(e => [e.id, e]))
  const allowed = (e: ToolEntry) => !p.readOnly || e.tool === 'select' || e.tool === 'pan'
  const favs = p.favorites.map(id => byId.get(id)).filter((e): e is ToolEntry => !!e && allowed(e))
  const recent = p.recent.map(id => byId.get(id)).filter((e): e is ToolEntry => !!e && allowed(e))
  const searching = q.trim() !== ''
  const all = orderBy(groupEntries(p.entries.filter(e => allowed(e) && e.group !== 'Select / Navigate')), g => g.name, p.chest.groupOrder)
    .map(g => ({ ...g, entries: orderBy(g.entries, e => e.id, p.chest.itemOrder[g.name]) }))
  const shownNames = all.map(g => g.name)
  const groups = all.filter(g => !groupPrefs(p.chest, g.name).hidden)
    .map(g => ({ ...g, entries: g.entries.filter(e => matchesSearch(e, q)) })).filter(g => g.entries.length)
  const keyOf = (e: ToolEntry) => p.hotkeys[entryCommand(e)] || ''

  const startDrag = (d: Drag) => (ev: React.DragEvent) => { setDrag(d); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', d.id) }
  const dropOnItem = (g: { name: string; entries: ToolEntry[] }, target: string | null) => (ev: React.DragEvent) => {
    ev.preventDefault()
    if (drag?.kind === 'item' && drag.group === g.name) p.onChest(moveItem(p.chest, g.name, g.entries.map(e => e.id), drag.id, target))
    setDrag(null)
  }

  const openItemMenu = (e: ToolEntry) => (ev: React.MouseEvent) => { ev.preventDefault(); setItemMenu({ x: ev.clientX, y: ev.clientY, entry: e }) }
  const itemMenuItems = (e: ToolEntry): MenuItem[] => [
    { label: p.favorites.includes(e.id) ? 'Unpin from favorites' : 'Pin to favorites', onClick: () => p.onToggleFavorite(e.id) },
    { label: '', separator: true },
    { label: 'Assign hotkey…', hint: keyOf(e) || undefined, disabled: p.readOnly && e.tool !== 'select' && e.tool !== 'pan', onClick: () => p.onAssignHotkey(e) },
    { label: 'Remove hotkey', disabled: !keyOf(e), onClick: () => p.onRemoveHotkey(e) },
    ...(p.onEditType && e.typeId ? [{ label: '', separator: true }, { label: 'Edit device type…', onClick: () => p.onEditType!(e) }] : []),
    ...(p.onAddType && e.setId ? [{ label: 'Add device type…', onClick: () => p.onAddType!(e.setId!) }] : []),
  ]

  const row = (e: ToolEntry, opts: { favDrag?: boolean; group?: { name: string; entries: ToolEntry[] } } = {}) => {
    const isFav = p.favorites.includes(e.id)
    const g = opts.group
    const canDrag = opts.favDrag || (!!g && !searching)
    return (
      <div key={e.id} className={`chest-row${p.activeId === e.id ? ' active' : ''}${drag?.id === e.id ? ' dragging' : ''}`}
        draggable={canDrag} title={`${e.label}${keyOf(e) ? ` (${keyOf(e)})` : ''} - right-click for options`}
        onDragStart={canDrag ? startDrag(opts.favDrag ? { kind: 'fav', id: e.id } : { kind: 'item', id: e.id, group: g!.name }) : undefined}
        onDragOver={canDrag ? ev => { if (drag && (opts.favDrag ? drag.kind === 'fav' : drag.kind === 'item' && drag.group === g!.name)) ev.preventDefault() } : undefined}
        onDrop={opts.favDrag
          ? ev => { ev.preventDefault(); if (drag?.kind === 'fav') p.onFavorites(reorderFavorites(p.favorites, drag.id, e.id)); setDrag(null) }
          : g ? dropOnItem(g, e.id) : undefined}
        onDragEnd={() => setDrag(null)}
        onContextMenu={openItemMenu(e)}>
        <button className="chest-pick" aria-pressed={p.activeId === e.id} onClick={() => p.onPick(e)}>
          <EntryIcon e={e} />
          <span className="chest-label">{e.label}</span>
          {keyOf(e) && <kbd className="chest-key">{keyOf(e)}</kbd>}
        </button>
        <button className={`chest-star${isFav ? ' on' : ''}`} aria-label={isFav ? `Unpin ${e.label}` : `Pin ${e.label} to favorites`} aria-pressed={isFav}
          onClick={() => p.onToggleFavorite(e.id)}><Icon name="star" size={16} fill={isFav ? 'currentColor' : 'none'} /></button>
      </div>
    )
  }

  const cell = (e: ToolEntry, g: { name: string; entries: ToolEntry[] }, px: number) => (
    <button key={e.id} className={`chest-cell${p.activeId === e.id ? ' active' : ''}${drag?.id === e.id ? ' dragging' : ''}`}
      draggable={!searching} aria-pressed={p.activeId === e.id} title={`${e.label}${keyOf(e) ? ` (${keyOf(e)})` : ''} - right-click for options`}
      aria-label={e.label} style={{ ['--chest-icon' as string]: `${px}px` }}
      onClick={() => p.onPick(e)}
      onDragStart={startDrag({ kind: 'item', id: e.id, group: g.name })}
      onDragOver={ev => { if (drag?.kind === 'item' && drag.group === g.name) ev.preventDefault() }}
      onDrop={dropOnItem(g, e.id)} onDragEnd={() => setDrag(null)}
      onContextMenu={openItemMenu(e)}>
      <EntryIcon e={e} px={px} />
      {e.initials && <span className="chest-initials">{e.initials}</span>}
    </button>
  )

  const menuItems = (name: string): MenuItem[] => {
    const gp = groupPrefs(p.chest, name)
    const set = (patch: Parameters<typeof setGroup>[2]) => () => p.onChest(setGroup(p.chest, name, patch))
    const mark = (on: boolean, label: string) => (on ? `✓ ${label}` : label)
    const sizes: ChestSize[] = ['small', 'medium', 'large']
    const hidden = hiddenGroupCount(p.chest)
    const setId = all.find(g => g.name === name)?.entries.find(e => e.setId)?.setId
    return [
      ...(p.onAddType && setId ? [{ label: 'Add device type…', onClick: () => p.onAddType!(setId) }, { label: '', separator: true }] : []),
      { label: gp.expanded ? 'Start collapsed' : 'Start expanded', onClick: set({ expanded: !gp.expanded }) },
      { label: '', separator: true },
      { label: mark(gp.view === 'list', 'List view'), onClick: set({ view: 'list' }) },
      { label: mark(gp.view === 'grid', 'Grid view (icons only)'), onClick: set({ view: 'grid' }) },
      { label: 'Icon size', sub: sizes.map(s => ({ label: mark(gp.size === s, s[0].toUpperCase() + s.slice(1)), onClick: set({ size: s }) })) },
      { label: '', separator: true },
      { label: 'Hide group', onClick: set({ hidden: true }) },
      { label: hidden ? `Show hidden groups (${hidden})` : 'Show hidden groups', disabled: !hidden, onClick: () => p.onChest(showAllGroups(p.chest)) },
      { label: 'Reset order', onClick: () => p.onChest(resetChestOrder(p.chest)) },
    ]
  }

  if (narrow) {
    // Icon strip: one flat grid, names and hotkeys on hover
    const seen = new Set<string>()
    const strip = [...favs, ...recent, ...all.flatMap(g => g.entries)].filter(e => allowed(e) && !seen.has(e.id) && !!seen.add(e.id))
    return (
      <div className="tool-chest strip" ref={rootRef}>
        <div className="chest-scroll chest-strip">
          {strip.map(e => (
            <button key={e.id} className={`chest-cell${p.activeId === e.id ? ' active' : ''}`} aria-pressed={p.activeId === e.id} aria-label={e.label}
              title={`${e.label}${keyOf(e) ? ` (${keyOf(e)})` : ''}`} onClick={() => p.onPick(e)} onContextMenu={openItemMenu(e)}>
              <EntryIcon e={e} px={ICON_PX.medium} />
            </button>
          ))}
        </div>
        {itemMenu && <ContextMenu x={itemMenu.x} y={itemMenu.y} items={itemMenuItems(itemMenu.entry)} onClose={() => setItemMenu(null)} />}
      </div>
    )
  }

  return (
    <div className="tool-chest" ref={rootRef}>
      <input type="search" className="chest-search" placeholder="Search tools" aria-label="Search tools" value={q} onChange={e => setQ(e.target.value)} />
      <div className="chest-scroll">
        {!searching && (
          <section aria-label="Favorites">
            <div className="chest-heading">Favorites</div>
            {favs.length === 0 && <div className="muted small chest-empty">Click a star to pin a tool here. Drag to reorder.</div>}
            <div className="chest-favs"
              onDragOver={ev => { if (drag?.kind === 'fav') ev.preventDefault() }}
              onDrop={ev => { if (ev.target === ev.currentTarget && drag?.kind === 'fav') { ev.preventDefault(); p.onFavorites(reorderFavorites(p.favorites, drag.id, null)); setDrag(null) } }}>
              {favs.map(e => row(e, { favDrag: true }))}
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
          const gp = groupPrefs(p.chest, g.name)
          const open = searching || (openNow[g.name] ?? gp.expanded)
          const px = ICON_PX[gp.size]
          const addSetId = p.onAddType ? all.find(a => a.name === g.name)?.entries.find(e => e.setId)?.setId : undefined
          return (
            <section key={g.name} aria-label={g.name} className={`chest-section${drag?.kind === 'group' && drag.id === g.name ? ' dragging' : ''}`}
              onDragOver={ev => { if (drag?.kind === 'group') ev.preventDefault() }}
              onDrop={ev => { if (drag?.kind === 'group') { ev.preventDefault(); p.onChest(moveGroup(p.chest, shownNames, drag.id, g.name)); setDrag(null) } }}>
              <div className="chest-group-row" style={{ display: 'flex', alignItems: 'center' }}>
              <button className="chest-heading chest-group" aria-expanded={open} draggable={!searching}
                title="Drag to reorder. Right-click for group options."
                onDragStart={startDrag({ kind: 'group', id: g.name })} onDragEnd={() => setDrag(null)}
                onContextMenu={ev => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, group: g.name }) }}
                onClick={() => setOpenNow(prev => ({ ...prev, [g.name]: !open }))}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /> {g.name}{g.isSet && <span className="muted small"> (symbols)</span>}
              </button>
              {addSetId && <button className="icon-btn" title="Add device type" aria-label={`Add device type to ${g.name}`}
                onClick={() => p.onAddType!(addSetId)}><Icon name="plus" size={14} /></button>}
              </div>
              {open && (gp.view === 'grid'
                ? <div className="chest-grid" onDragOver={ev => { if (drag?.kind === 'item' && drag.group === g.name) ev.preventDefault() }}
                    onDrop={ev => { if (ev.target === ev.currentTarget) dropOnItem(g, null)(ev) }}>{g.entries.map(e => cell(e, g, px))}</div>
                : g.entries.map(e => row(e, { group: g })))}
            </section>
          )
        })}
        {searching && groups.length === 0 && <div className="muted small chest-empty">No tools match.</div>}
        {!searching && hiddenGroupCount(p.chest) > 0 && (
          <button className="link-btn small chest-hidden" onClick={() => p.onChest(showAllGroups(p.chest))}>
            Show {hiddenGroupCount(p.chest)} hidden group{hiddenGroupCount(p.chest) === 1 ? '' : 's'}
          </button>
        )}
      </div>
      {itemMenu && <ContextMenu x={itemMenu.x} y={itemMenu.y} items={itemMenuItems(itemMenu.entry)} onClose={() => setItemMenu(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.group)} onClose={() => setMenu(null)} />}
    </div>
  )
}
