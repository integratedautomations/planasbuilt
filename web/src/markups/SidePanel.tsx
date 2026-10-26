import { Fragment, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { clearTextSelection, clickSelect, guardRangeMouseDown, keySelect } from '../ui/listSelection'
import type { FormEvent, PointerEvent as RPointerEvent } from 'react'
import { STATUSES } from './types'
import type { Layer, Markup, MarkupStyle, SymbolSet } from './types'
import { DeviceFields } from './DeviceFields'
import { LegendPanel } from './LegendPanel'
import type { LegendRow } from './legend'
import { Attribution, HistorySection } from './MarkupInfo'
import { ScaleControl } from './ScaleControl'
import type { PageScale } from './ScaleControl'
import { circleStats, formatArea, formatFeetInches, summarize } from './measure'
import { CABLE_FIELD, CABLE_MODES, CABLE_MODE_LABEL, DEFAULT_CABLE_SETTINGS, cableCount, cableMode, cableLength, cableTypeId, clearDangling, danglingEnds, summarizeCables, viaOf } from './cables'
import type { CableSettings } from './cables'
import { useCatalogContext } from '../catalog/useCatalog'
import type { MeasureTotal } from './measure'
import { commonValue } from './mixed'
import { tagRange } from './stacks'
import { DeviceSizeControl } from '../viewer/DeviceSize'
import type { Stack, StackIndex } from './stacks'

export type PanelTab = 'props' | 'measure' | 'layers' | 'areas'

/** Everything the Areas tab and area/device panels need, computed once in ViewerPage. */
export interface AreasProps {
  /** Every area on this page (including the sheet area). */
  pageAreas: Markup[]
  parentOf: (id: string) => string | null
  /** Computed area names, outermost first, for a device/markup or for an area itself. */
  pathOf: (m: Markup) => string[]
  /** Devices inside an area, counting nested areas. */
  deviceCount: (id: string) => number
  parentChoices: (a: Markup) => Markup[]
  show: boolean
  onShow: (v: boolean) => void
  onSelectArea: (id: string) => void
  /** Replace the selection with these areas (multi-select; no zoom). */
  onSelectAreas: (ids: string[]) => void
  onDraw: () => void
  onNameSheet: () => void
}

export interface MeasureProps {
  scale: PageScale | null
  pageMarkups: Markup[]
  onPreset: (s: PageScale) => void
  onCalibrate: () => void
  onApplyAll: () => void
  onClearScale: () => void
  scaleBusy: boolean
  scaleError: string
  onSelectIds: (ids: string[]) => void
}

const SWATCHES = ['#e03131', '#e8590c', '#f59f00', '#2f9e44', '#1971c2', '#7048e8', '#000000', '#868e96']
const STAMPS = ['APPROVED', 'REVISED', 'VOID', 'FIELD VERIFY', 'AS-BUILT', 'NOT IN SCOPE']

/** What the Layers panel needs. */
export type LayersProps = Pick<Props, 'layers' | 'activeLayerId' | 'onActiveLayer' | 'hidden' | 'locked' | 'onToggleHidden' | 'onToggleLocked' | 'onAddLayer' | 'readOnly' | 'symbolSets' | 'display'>

export type SheetSnap = 'peek' | 'half' | 'full'
const SNAPS: SheetSnap[] = ['peek', 'half', 'full']
const SNAP_FRACTION: Record<SheetSnap, number> = { peek: 0.25, half: 0.5, full: 1 }
const PEEK_MIN = 132

/** Pixel height of a snap point inside a container of the given height. */
export function sheetHeight(snap: SheetSnap, containerH: number) {
  return Math.min(containerH, Math.max(snap === 'peek' ? PEEK_MIN : 0, containerH * SNAP_FRACTION[snap]))
}

/** Phone bottom-sheet mode: the panel gets a drag handle and three snap heights. */
export interface SheetProps { snap: SheetSnap; onSnap: (s: SheetSnap) => void; onClose: () => void }

interface Props {
  sheet?: SheetProps
  tab: PanelTab
  onTab: (t: PanelTab) => void
  measure: MeasureProps
  areas: AreasProps
  selected: Markup[]
  readOnly: boolean
  /** Field and sub roles: read-only canvas, but device fields, status, notes and photos stay editable. */
  fieldsOnly?: boolean
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
  symbolSets: Map<string, SymbolSet>
  /** Live rows of each legend on this page (for manual row ordering). */
  legendRows?: Map<string, LegendRow[]>
  /** Per-viewer display options shown at the top of the Layers tab. */
  display: { showCones: boolean; onShowCones: (v: boolean) => void; showCables?: boolean; onShowCables?: (v: boolean) => void; deviceScale?: number; onDeviceScale?: (v: number) => void; deviceScaleReadOnly?: boolean }
  /** Device stacks on this page and the actions the stack panel needs. */
  stacks: StackIndex
  onSelectIds: (ids: string[]) => void
  onAddToStack: (stack: Stack) => void
  onPullOut: (m: Markup) => void
  onDeleteStack: (stack: Stack) => void
  /** Project cable defaults (slack %, drop ft). */
  cableDefaults?: CableSettings
  /** Re-enter cable drawing from a free end of the selected cable run. */
  onContinueRun?: () => void
  /** Opens the "Replace with..." dialog for the selected devices. */
  onReplace?: () => void
  /** Desktop: keep the panel open with nothing selected. */
  pinned?: boolean
  onPinned?: (v: boolean) => void
}

const MEASURE_TYPES: Markup['type'][] = ['measure-length', 'measure-polylength', 'measure-area', 'measure-radius', 'count', 'cable']

/** Collapsible block inside the one-scroll Properties panel; open/closed is remembered in this browser. */
export function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const key = `planmark.psec.${title}`
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(key); return v === null ? defaultOpen : v === '1' } catch { return defaultOpen } })
  const toggle = () => setOpen(o => { try { localStorage.setItem(key, o ? '0' : '1') } catch { /* ignore */ } return !o })
  return (
    <section className="psec">
      <button type="button" className="psec-head" aria-expanded={open} onClick={toggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />{title}
      </button>
      {open && <div className="psec-body">{children}</div>}
    </section>
  )
}

export function SidePanel(p: Props) {
  const { tab, onTab: setTab } = p
  const ref = useRef<HTMLElement>(null)
  if (!p.sheet) {
    // Desktop: one scroll; Measure appears only when it is relevant, Layers has its own panel
    const relevant = p.selected.length ? p.selected.some(m => MEASURE_TYPES.includes(m.type)) : p.measure.pageMarkups.some(m => MEASURE_TYPES.includes(m.type))
    return (
      <aside ref={ref} className="side-panel props-panel">
        {p.onPinned && (
          <div className="props-pinrow">
            <button className={'icon-btn small' + (p.pinned ? ' active' : '')} aria-pressed={!!p.pinned} onClick={() => p.onPinned!(!p.pinned)}
              title={p.pinned ? 'Unpin: Properties closes when nothing is selected' : 'Pin: keep Properties open when nothing is selected'}
              aria-label="Pin Properties"><Icon name="pin" size={16} /></button>
          </div>
        )}
        <div className="props-scroll">
          <Properties {...p} />
          {relevant && <Section title="Measure"><Measure {...p} /></Section>}
        </div>
      </aside>
    )
  }
  return (
    <aside ref={ref} className={`side-panel sheet snap-${p.sheet.snap}`}>
      <SheetHandle sheet={p.sheet} asideRef={ref} />
      <div className="panel-tabs">
        <button className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>Properties</button>
        <button className={tab === 'measure' ? 'active' : ''} onClick={() => setTab('measure')}>Measure</button>
        <button className={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}>Layers</button>
        <button className={tab === 'areas' ? 'active' : ''} onClick={() => setTab('areas')}>Areas</button>
      </div>
      {tab === 'props' ? <Properties {...p} /> : tab === 'measure' ? <Measure {...p} /> : tab === 'areas' ? <Areas {...p} /> : <Layers {...p} />}
    </aside>
  )
}

function SheetHandle({ sheet, asideRef }: { sheet: SheetProps; asideRef: React.RefObject<HTMLElement | null> }) {
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null)
  const containerH = () => asideRef.current?.parentElement?.clientHeight ?? window.innerHeight

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    const el = asideRef.current
    if (!el) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: el.offsetHeight, moved: false }
    el.classList.add('dragging')
  }
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = asideRef.current
    if (!d || !el) return
    if (Math.abs(e.clientY - d.y) > 6) d.moved = true
    if (d.moved) el.style.height = `${Math.min(containerH(), Math.max(60, d.h + d.y - e.clientY))}px`
  }
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = asideRef.current
    drag.current = null
    if (!d || !el) return
    const h = el.offsetHeight
    el.classList.remove('dragging')
    el.style.height = ''
    if (!d.moved) { sheet.onSnap(SNAPS[(SNAPS.indexOf(sheet.snap) + 1) % SNAPS.length]); return }
    if (e.type === 'pointerup' && h < PEEK_MIN * 0.6) { sheet.onClose(); return }
    const ch = containerH()
    sheet.onSnap(SNAPS.reduce((best, s) => Math.abs(sheetHeight(s, ch) - h) < Math.abs(sheetHeight(best, ch) - h) ? s : best))
  }

  return (
    <div className="sheet-handle" role="button" aria-label="Resize properties sheet" tabIndex={0}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') sheet.onSnap(SNAPS[(SNAPS.indexOf(sheet.snap) + 1) % SNAPS.length]) }}>
      <span className="grip" />
    </div>
  )
}

function Properties(p: Props) {
  const { selected, readOnly, onUpdate, onDelete, symbolSets } = p
  if (selected.length && selected.every(m => m.type === 'device')) {
    const first = selected[0]
    const sameSet = selected.every(m => m.symbol_set_id === first.symbol_set_id)
    const stack = p.stacks.byId.get(first.id)
    // Whole stack selected -> stack panel; one member of a stack -> back link + pull out
    const whole = !!stack && selected.length === stack.members.length && selected.every(m => p.stacks.byId.get(m.id) === stack)
    const one = selected.length === 1 && !!stack
    const set = sameSet && first.symbol_set_id ? symbolSets.get(first.symbol_set_id) : undefined
    return (
      <div className="panel-body">
        {one && <button className="stack-back" onClick={() => p.onSelectIds(stack.members.map(m => m.id))}>{'‹'} Back to stack ({stack.members.length})</button>}
        {whole && <StackMembers stack={stack} set={set} onPick={id => p.onSelectIds([id])} />}
        <Section title="Device">
          <DeviceFields devices={selected} readOnly={readOnly && !p.fieldsOnly} limited={p.fieldsOnly} onUpdate={onUpdate} set={set} scale={p.measure.scale?.pointsPerFoot ?? null}
            heading={whole ? `Stack ×${selected.length} · ${tagRange(selected.map(m => m.tag ?? ''))}` : undefined}
            areaPath={selected.length === 1 ? p.areas.pathOf(first) : undefined} />
        </Section>
        <Section title="Placement">
          <LayerSelect {...p} />
          {!readOnly && p.onReplace && <button onClick={p.onReplace} title="Swap for another symbol set, device type or product; keeps position, photos and matching fields">Replace with…</button>}
        </Section>
        {!readOnly && stack && (one || whole) && (
          <div className="stack-actions">
            <button onClick={() => p.onAddToStack(stack)}>+1 to stack</button>
            {one && <button onClick={() => p.onPullOut(first)}>Pull out</button>}
          </div>
        )}
        {!readOnly && whole && (
          <button className="danger stack-delete" onClick={() => {
            if (window.confirm(`Delete this stack of ${stack.members.length} devices (${tagRange(stack.members.map(m => m.tag ?? ''))})?`)) p.onDeleteStack(stack)
          }}>Delete stack</button>
        )}
        {!readOnly && !whole && <button className="danger" onClick={onDelete}>Delete {selected.length > 1 ? `${selected.length} devices` : 'device'}</button>}
      </div>
    )
  }
  if (selected.length === 1 && selected[0].type === 'area') return <AreaProperties {...p} />
  if (selected.length === 1 && selected[0].type === 'legend') return <LegendProperties {...p} />
  return <StyleProperties {...p} />
}

/** Key field shown beside a stacked device: an IP/address field if filled in, else the serial number. */
function keyPreview(m: Markup, set?: SymbolSet): string {
  const pick = (set?.fields ?? []).find(f => (f.type === 'ip' || /address|ip/i.test(f.key)) && m.fields?.[f.key] !== undefined && m.fields[f.key] !== '')
  const v = pick ? m.fields?.[pick.key] : m.fields?.serial
  return v === undefined || v === '' ? '' : `${pick ? `${pick.label}: ` : 'S/N '}${v}`
}

function StackMembers({ stack, set, onPick }: { stack: Stack; set?: SymbolSet; onPick: (id: string) => void }) {
  return (
    <ul className="layer-list stack-members" aria-label="Devices in this stack">
      {stack.members.map(m => {
        const st = STATUSES.find(s => s.value === m.status)
        return (
          <li key={m.id} style={{ display: 'block' }}>
            <button className="stack-row" onClick={() => onPick(m.id)}>
              <span className="dot" title={st?.label ?? 'No status'} style={{ background: st?.color ?? '#adb5bd' }} />
              <span className="stack-tag">{m.tag || 'New'}</span>
              <span className="muted small stack-key">{keyPreview(m, set)}</span>
              <span className="muted" aria-hidden>{'›'}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function LegendProperties(p: Props) {
  const m = p.selected[0]
  return (
    <LegendPanel m={m} readOnly={p.readOnly} onUpdate={p.onUpdate} onDelete={p.onDelete} pageAreas={p.areas.pageAreas} symbolSets={p.symbolSets} rows={p.legendRows?.get(m.id) ?? []}>
      <LayerSelect {...p} />
    </LegendPanel>
  )
}

function AreaProperties(p: Props) {
  const { selected, readOnly, onUpdate, onDelete, areas } = p
  const a = selected[0]
  const sheet = a.fields?.sheet === true
  const path = areas.pathOf(a)
  const override = typeof a.fields?.parent_id === 'string' ? a.fields.parent_id : ''
  const choices = areas.parentChoices(a)
  const auto = areas.parentOf(a.id)
  const nameOf = (m: Markup) => m.text.trim() || (m.fields?.sheet === true ? 'Unnamed sheet' : 'Unnamed area')
  const setParent = (v: string) => onUpdate(m => {
    const { parent_id: _drop, ...rest } = m.fields ?? {}
    return { ...m, fields: v ? { ...rest, parent_id: v } : rest }
  }, 'parent')
  const autoParent = auto ? areas.pageAreas.find(x => x.id === auto) : undefined
  return (
    <div className="panel-body">
      <div className="panel-heading">{sheet ? 'Sheet area' : 'Area'}</div>
      <Attribution markup={a} />
      <fieldset disabled={readOnly} className="stack">
        <label className="field">Name
          <input value={a.text} placeholder={sheet ? 'e.g. First Floor' : 'e.g. Living Room'}
            onChange={e => onUpdate(m => ({ ...m, text: e.target.value }), `text.${a.id}`)} />
        </label>
        {!sheet && (
          <label className="field">Parent
            <select value={choices.some(c => c.id === override) ? override : ''} onChange={e => setParent(e.target.value)}>
              <option value="">Automatic{autoParent && !override ? ` (${nameOf(autoParent)})` : ''}</option>
              {choices.map(c => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}
            </select>
          </label>
        )}
        <div className="field">Full path
          <div className="area-path">{path.length ? path.join(' › ') : '—'}</div>
        </div>
        <div className="field">Devices inside
          <div><b>{areas.deviceCount(a.id)}</b></div>
        </div>
        {!readOnly && <button className="danger" onClick={onDelete}>{sheet ? 'Remove sheet area' : 'Delete area'}</button>}
      </fieldset>
      <HistorySection markup={a} />
    </div>
  )
}

/** Areas of the current sheet as a tree (its own dock panel on desktop; a Properties tab on phones). */
export function Areas({ areas, readOnly, selected, onDelete }: Pick<Props, 'areas' | 'readOnly' | 'selected'> & { onDelete?: () => void }) {
  const anchor = useRef<string | null>(null)
  const kids = new Map<string | null, Markup[]>()
  const ids = new Set(areas.pageAreas.map(a => a.id))
  for (const a of areas.pageAreas) {
    const par = areas.parentOf(a.id)
    const key = par && ids.has(par) ? par : null
    kids.set(key, [...(kids.get(key) ?? []), a])
  }
  for (const list of kids.values()) list.sort((x, y) => (x.text || '').localeCompare(y.text || ''))
  const sheet = areas.pageAreas.find(a => a.fields?.sheet === true)
  const order: string[] = []
  const walk = (a: Markup) => { order.push(a.id); (kids.get(a.id) ?? []).forEach(walk) }
  ;(kids.get(null) ?? []).forEach(walk)
  const selectedAreaIds = selected.filter(m => m.type === 'area').map(m => m.id)
  const node = (a: Markup, depth: number): React.ReactNode => (
    <li key={a.id} style={{ display: 'block' }}>
      <button className={`area-row${selected.some(s => s.id === a.id) ? ' active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}
        onMouseDown={guardRangeMouseDown}
        onClick={e => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            const r = clickSelect(order, { selected: selectedAreaIds, anchor: anchor.current }, a.id, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })
            anchor.current = r.anchor
            areas.onSelectAreas(r.selected)
            clearTextSelection()
          } else { anchor.current = a.id; areas.onSelectArea(a.id) }
        }} title="Select and zoom to fit (Ctrl/Shift+click for several)">
        <span className="area-name">{a.text.trim() || (a.fields?.sheet === true ? 'Unnamed sheet' : 'Unnamed area')}</span>
        <span className="muted small">{areas.deviceCount(a.id)}</span>
      </button>
      {(kids.get(a.id) ?? []).length > 0 && <ul className="layer-list">{(kids.get(a.id) ?? []).map(c => node(c, depth + 1))}</ul>}
    </li>
  )
  const roots = kids.get(null) ?? []
  return (
    <div className="panel-body" tabIndex={-1} onKeyDown={e => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return
      const r = keySelect(order, { selected: selectedAreaIds, anchor: anchor.current }, e)
      if (r) { e.preventDefault(); e.stopPropagation(); anchor.current = r.anchor; areas.onSelectAreas(r.selected) }
    }}>
      <div className="panel-heading">Areas, this sheet</div>
      {!readOnly && (
        <div className="area-actions">
          <button onClick={() => areas.onDraw()} title="Drag for a rectangle, or click corners">Draw area</button>
          <button onClick={areas.onNameSheet}>{sheet ? 'Rename sheet' : 'Name this sheet'}</button>
          {onDelete && selectedAreaIds.length > 1 && <button className="danger" onClick={onDelete}>Delete {selectedAreaIds.length} areas</button>}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={areas.show} onChange={e => areas.onShow(e.target.checked)} /> Show area outlines and labels</label>
      {roots.length ? <ul className="layer-list">{roots.map(a => node(a, 0))}</ul>
        : <p className="muted small">No areas yet. Draw one around a room or floor; areas can sit inside areas. Numbers are devices inside.</p>}
    </div>
  )
}

function LayerSelect({ selected, layers, onUpdate, readOnly }: Props) {
  const layer = commonValue(selected, m => m.layer_id ?? '')
  return (
    <label className="field">Layer
      <select disabled={readOnly} value={layer.mixed ? '__mixed' : layer.value ?? ''} onChange={e => { if (e.target.value !== '__mixed') onUpdate(m => ({ ...m, layer_id: e.target.value || null }), 'layer') }}>
        {layer.mixed && <option value="__mixed" disabled>Mixed</option>}
        <option value="">Default</option>
        {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  )
}

function StyleProperties(p: Props) {
  const { selected, readOnly, defaultStyle, onDefaultStyle, stampText, onStampText, onUpdate, onDelete, textRef } = p
  const first = selected[0]
  const cs = <K extends keyof MarkupStyle>(k: K) => commonValue(selected, m => m.style[k])
  const style: MarkupStyle = first ? { ...first.style, ...Object.fromEntries((['stroke', 'fill', 'strokeWidth', 'opacity', 'fontSize', 'dash'] as const).map(k => [k, cs(k).value])) } : defaultStyle
  const mixedStyle = (k: keyof MarkupStyle) => !!first && cs(k).mixed
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
      {selected.length === 1 && <Attribution markup={first} />}
      {selected.length === 1 && first.type === 'measure-radius' && 'points' in first.geometry && (
        <Section title="Measurement">
          {p.measure.scale ? (() => {
            const c = circleStats(first.geometry.points, p.measure.scale.pointsPerFoot)
            return (
              <dl className="kv">
                <dt>Radius</dt><dd>{formatFeetInches(c.radius)}</dd>
                <dt>Diameter</dt><dd>{formatFeetInches(c.diameter)}</dd>
                <dt>Area</dt><dd>{formatArea(c.area)}</dd>
              </dl>
            )
          })() : <p className="scale-warn small">Set a scale to see the radius, diameter and area.</p>}
        </Section>
      )}
      {selected.length > 0 && selected.every(m => m.type === 'cable') && <CableSection {...p} />}
      <fieldset disabled={disabled} className="stack">
        <Section title="Style">
        <label className="field">Color{mixedStyle('stroke') && <span className="muted"> Mixed</span>}
          <div className="swatches">
            {SWATCHES.map(c => (
              <button key={c} className={`swatch${!mixedStyle('stroke') && style.stroke === c ? ' on' : ''}`} style={{ background: c }}
                aria-label={c} onClick={() => setStyle({ stroke: c }, 'stroke')} />
            ))}
            <input type="color" value={style.stroke || '#000000'} onChange={e => setStyle({ stroke: e.target.value }, 'stroke')} />
          </div>
        </label>
        <label className="field">Fill{mixedStyle('fill') && <span className="muted"> Mixed</span>}
          <div className="swatches">
            <button className={`swatch none${!mixedStyle('fill') && !style.fill ? ' on' : ''}`} aria-label="No fill" onClick={() => setStyle({ fill: '' }, 'fill')} />
            {SWATCHES.slice(0, 6).map(c => (
              <button key={c} className={`swatch${style.fill === c ? ' on' : ''}`} style={{ background: c }}
                aria-label={`fill ${c}`} onClick={() => setStyle({ fill: c }, 'fill')} />
            ))}
            <input type="color" value={style.fill || '#ffffff'} onChange={e => setStyle({ fill: e.target.value }, 'fill')} />
          </div>
        </label>
        <label className="field">Line width <span className="muted">{mixedStyle('strokeWidth') ? 'Mixed' : style.strokeWidth}</span>
          <input type="range" min={0.5} max={20} step={0.5} value={style.strokeWidth}
            onChange={e => setStyle({ strokeWidth: +e.target.value }, 'strokeWidth')} />
        </label>
        <label className="field">Opacity <span className="muted">{mixedStyle('opacity') ? 'Mixed' : `${Math.round(style.opacity * 100)}%`}</span>
          <input type="range" min={0.1} max={1} step={0.05} value={style.opacity}
            onChange={e => setStyle({ opacity: +e.target.value }, 'opacity')} />
        </label>
        <label className="field">Font size <span className="muted">{mixedStyle('fontSize') ? 'Mixed' : style.fontSize}</span>
          <input type="range" min={6} max={96} step={1} value={style.fontSize}
            onChange={e => setStyle({ fontSize: +e.target.value }, 'fontSize')} />
        </label>
        <label className="check"><input type="checkbox" checked={!!style.dash} ref={el => { if (el) el.indeterminate = mixedStyle('dash') }}
          onChange={e => setStyle({ dash: e.target.checked }, 'dash')} /> Dashed line</label>
        </Section>

        {hasText && selected.length === 1 && (
          <label className="field">{first.type === 'stamp' ? 'Stamp text' : 'Text'}
            <textarea ref={textRef} rows={3} value={first.text}
              onChange={e => onUpdate(m => ({ ...m, text: e.target.value }), `text.${first.id}`)} />
          </label>
        )}
        {(!first || selected.every(m => m.type === 'stamp')) && (
          <label className="field">{first ? 'Preset' : 'Stamp'}
            <select value={first ? '' : stampText} onChange={e => {
              if (!e.target.value) return
              if (first) onUpdate(m => (m.type === 'stamp' ? { ...m, text: e.target.value } : m), `text.${first.id}`)
              else onStampText(e.target.value)
            }}>
              {first && <option value="">Choose{'…'}</option>}
              {STAMPS.map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
        )}
        {first && <LayerSelect {...p} />}
        {first && !readOnly && <button className="danger" onClick={onDelete}>Delete {selected.length > 1 ? `${selected.length} markups` : 'markup'}</button>}
      </fieldset>
      {selected.length === 1 && <HistorySection markup={first} />}
    </div>
  )
}

function Measure({ measure: m, readOnly, cableDefaults }: Props) {
  const cat = useCatalogContext()
  const sum = summarize(m.pageMarkups, m.scale?.pointsPerFoot ?? null)
  // Cable runs are totalled with slack, drops and run counts, per cable type
  const cables = summarizeCables(m.pageMarkups, m.scale?.pointsPerFoot ?? null, cat.cableTypes, cableDefaults ?? DEFAULT_CABLE_SETTINGS)
  sum.cable = cables.rows; sum.cableTotal = cables.total
  const row = (t: MeasureTotal) => (
    <li key={t.key}>
      <button className="measure-row" onClick={() => m.onSelectIds(t.ids)} title={`Select ${t.ids.length} markup${t.ids.length > 1 ? 's' : ''}`}>
        <span className="dot" style={{ background: t.color }} />
        <span className="measure-name">{t.label}{t.ids.length > 1 || t.label.startsWith('Count') ? ` (${t.ids.length})` : ''}</span>
        <span className="measure-value">{t.value}</span>
      </button>
    </li>
  )
  const block = (title: string, rows: MeasureTotal[], total: string) => rows.length > 0 && (
    <>
      <div className="panel-heading measure-head"><span>{title}</span>{total && <span className="measure-total">{total}</span>}</div>
      <ul className="layer-list">{rows.map(row)}</ul>
    </>
  )
  const empty = !sum.length.length && !sum.area.length && !sum.cable.length && !sum.radius.length && !sum.count.length
  return (
    <div className="panel-body">
      <ScaleControl scale={m.scale} readOnly={readOnly} busy={m.scaleBusy} error={m.scaleError}
        onPreset={m.onPreset} onCalibrate={m.onCalibrate} onApplyAll={m.onApplyAll} onClear={m.onClearScale} />
      <div className="panel-heading">Totals, this sheet</div>
      {sum.unscaled > 0 && <p className="scale-warn small">{sum.unscaled} measurement{sum.unscaled > 1 ? 's' : ''} need a scale.</p>}
      {block('Length', sum.length, sum.lengthTotal)}
      {block('Area', sum.area, sum.areaTotal)}
      {block('Radius', sum.radius, '')}
      {block('Cable runs', sum.cable, sum.cableTotal)}
      {block('Counts', sum.count, '')}
      {empty && sum.unscaled === 0 && <p className="muted small">Use the Length, Polylength, Area, Radius and Count tools to see totals here.</p>}
    </div>
  )
}

export function Layers({ layers, activeLayerId, onActiveLayer, hidden, locked, onToggleHidden, onToggleLocked, onAddLayer, readOnly, symbolSets, display }: LayersProps) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const all = [{ id: '', name: 'Default', color: '#868e96' }, ...layers]

  async function add(e: FormEvent) {
    e.preventDefault()
    try { await onAddLayer(name); setName(''); setError('') } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="panel-body">
      <div className="panel-heading">Display</div>
      <label className="check"><input type="checkbox" checked={display.showCones} onChange={e => display.onShowCones(e.target.checked)} /> Show coverage</label>
      {display.onShowCables && <label className="check"><input type="checkbox" checked={display.showCables !== false} onChange={e => display.onShowCables!(e.target.checked)} /> Show cable runs</label>}
      {display.onDeviceScale && (
        <>
          <div className="panel-heading">Device size</div>
          <DeviceSizeControl value={display.deviceScale ?? 1} readOnly={display.deviceScaleReadOnly} onChange={display.onDeviceScale} />
        </>
      )}
      <div className="panel-heading">Layers</div>
      <p className="muted small">The selected layer gets new markups.</p>
      <ul className="layer-list">
        {all.map(l => (
          <li key={l.id} className={(activeLayerId ?? '') === l.id ? 'active' : ''}>
            <button className="layer-name" onClick={() => onActiveLayer(l.id || null)}>
              <span className="dot" style={{ background: l.color }} />{l.name}
            </button>
            <button className="icon-btn small" title={hidden.has(l.id) ? 'Show' : 'Hide'} onClick={() => onToggleHidden(l.id)}>
              <Icon name={hidden.has(l.id) ? 'eye-off' : 'eye'} size={16} />
            </button>
            <button className="icon-btn small" title={locked.has(l.id) ? 'Unlock' : 'Lock'} onClick={() => onToggleLocked(l.id)}>
              <Icon name="lock" size={16} className={locked.has(l.id) ? '' : 'dim'} />
            </button>
          </li>
        ))}
      </ul>
      <div className="panel-heading">Symbol sets</div>
      <ul className="layer-list">
        {[...symbolSets.values()].map(set => {
          const key = `set:${set.id}`
          return (
            <li key={key}>
              <span className="layer-name"><span className="dot" style={{ background: set.color }} />{set.name}</span>
              <button className="icon-btn small" title={hidden.has(key) ? 'Show' : 'Hide'} onClick={() => onToggleHidden(key)}>
                <Icon name={hidden.has(key) ? 'eye-off' : 'eye'} size={16} />
              </button>
              <button className="icon-btn small" title={locked.has(key) ? 'Unlock' : 'Lock'} onClick={() => onToggleLocked(key)}>
                <Icon name="lock" size={16} className={locked.has(key) ? '' : 'dim'} />
              </button>
            </li>
          )
        })}
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

/** Cable runs: type, runs, slack and drop (per-cable overrides of the project defaults), the two ends and the resulting length. */
function CableSection({ selected, readOnly, onUpdate, measure, cableDefaults, onContinueRun }: Props) {
  const cat = useCatalogContext()
  const defaults = cableDefaults ?? DEFAULT_CABLE_SETTINGS
  const byId = new Map(measure.pageMarkups.map(m => [m.id, m]))
  const one = selected.length === 1 ? selected[0] : null
  const type = commonValue(selected, m => cableTypeId(m))
  const count = commonValue(selected, m => cableCount(m))
  const slack = commonValue(selected, m => String(m.fields?.[CABLE_FIELD.slack] ?? ''))
  const drop = commonValue(selected, m => String(m.fields?.[CABLE_FIELD.drop] ?? ''))
  const mode = commonValue(selected, m => cableMode(m, defaults))
  const setField = (key: string, value: string | number | null) => onUpdate(m => {
    const fields = { ...(m.fields ?? {}) }
    if (value === null || value === '') delete fields[key]; else fields[key] = value
    return { ...m, fields }
  }, `cable.${key}`)
  const numInput = (key: string, v: { mixed: boolean; value: string | undefined }, placeholder: string) => (
    <input type="number" min={0} step="any" inputMode="decimal" value={v.mixed ? '' : v.value ?? ''} placeholder={v.mixed ? 'Mixed' : placeholder}
      onChange={e => { const n = e.target.value === '' ? null : Number(e.target.value); if (n === null || (Number.isFinite(n) && n >= 0)) setField(key, n) }} />
  )
  const len = one ? cableLength(one, measure.scale?.pointsPerFoot ?? null, defaults, byId) : null
  const g = one && 'points' in one.geometry ? one.geometry : null
  const dangling = one ? danglingEnds(one, byId) : []
  const endText = (end: 'from' | 'to') => {
    const ref = g?.[end]
    const d = ref ? byId.get(ref) : undefined
    if (dangling.includes(end)) return 'Open (device removed)'
    return d ? (d.tag || 'Device') : 'Free end'
  }
  const types = cat.cableTypeList
  const current = type.mixed ? undefined : cat.cableTypes.get(type.value ?? '')
  return (
    <Section title="Cable">
      <fieldset disabled={readOnly} className="stack">
        <label className="field">Cable type
          <select value={type.mixed ? '__mixed' : type.value ?? ''} onChange={e => { if (e.target.value !== '__mixed') setField(CABLE_FIELD.type, e.target.value) }}>
            {type.mixed && <option value="__mixed" disabled>Mixed</option>}
            <option value="">No type</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            {current?.archived && <option value={current.id}>{current.name} (removed)</option>}
          </select>
        </label>
        <label className="field">Runs (conductors / cables)
          <input type="number" min={1} step={1} value={count.mixed ? '' : count.value ?? 1} placeholder={count.mixed ? 'Mixed' : '1'}
            onChange={e => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n) && n >= 1) setField(CABLE_FIELD.count, n === 1 ? null : n) }} />
        </label>
        <label className="field">Measured as
          <select value={mode.mixed ? '__mixed' : mode.value ?? 'daisy'} onChange={e => { if (e.target.value !== '__mixed') setField(CABLE_FIELD.mode, e.target.value === (defaults.mode ?? 'daisy') ? null : e.target.value) }}>
            {mode.mixed && <option value="__mixed" disabled>Mixed</option>}
            {CABLE_MODES.map(k => <option key={k} value={k}>{CABLE_MODE_LABEL[k]}{k === (defaults.mode ?? 'daisy') ? ' (project default)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Slack % <span className="muted small">(blank = project {defaults.slackPct}%)</span>
          {numInput(CABLE_FIELD.slack, slack, String(defaults.slackPct))}
        </label>
        <label className="field">Drop at each linked end, ft <span className="muted small">(blank = project {defaults.dropFt} ft)</span>
          {numInput(CABLE_FIELD.drop, drop, String(defaults.dropFt))}
        </label>
      </fieldset>
      {one && (
        <>
          <dl className="kv">
            <dt>From</dt><dd>{endText('from')}</dd>
            {g && viaOf(g).map((v, k) => <Fragment key={v.i}><dt>Via {k + 1}</dt><dd>{byId.get(v.id)?.tag || 'Device'}</dd></Fragment>)}
            <dt>To</dt><dd>{endText('to')}</dd>
            {len && <><dt>Drawn</dt><dd>{formatFeetInches(len.drawnFt)}</dd>
              <dt>One run</dt><dd>{formatFeetInches(len.runFt)}</dd>
              <dt>Total{len.count > 1 ? ` x${len.count}` : ''}</dt><dd>{formatFeetInches(len.totalFt)}</dd></>}
          </dl>
          {!len && <p className="scale-warn small">Set a scale to see the length.</p>}
          {len && len.mode === 'home' && <p className="muted small">Home runs: {len.homeRuns} cable{len.homeRuns === 1 ? '' : 's'}, each from the start along the path to its device: path x (1 + {len.slackPct}%) + {len.dropFt} ft drop at the device{len.ends > 0 && len.dropFt > 0 ? ' and at the start' : ''}. One run = {formatFeetInches(len.runFt)} in total.</p>}
          {len && len.mode !== 'home' && (() => { const n = len.ends + (defaults.viaDrop === false ? 0 : len.via); return <p className="muted small">Run = drawn x (1 + {len.slackPct}%) + {len.dropFt} ft x {n} linked device{n === 1 ? '' : 's'} ({len.ends} end{len.ends === 1 ? '' : 's'}{len.via ? `, ${len.via} passed through${defaults.viaDrop === false ? ', no drop' : ''}` : ''}).</p> })()}
          {!readOnly && onContinueRun && <button onClick={onContinueRun}>Continue run</button>}
          {!readOnly && dangling.length > 0 && (
            <button onClick={() => onUpdate(m => ('points' in m.geometry ? { ...m, geometry: clearDangling(m.geometry, m, byId) } : m), 'cable.clear')}>Clear open-end markers</button>
          )}
        </>
      )}
    </Section>
  )
}

function labelFor(t: Markup['type']) {
  return ({ rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', highlight: 'Highlight', text: 'Text box', stamp: 'Stamp', legend: 'Legend',
    line: 'Line', arrow: 'Arrow', polyline: 'Polyline', polygon: 'Polygon', freehand: 'Pen', device: 'Device', area: 'Area', cable: 'Cable run',
    'measure-length': 'Length', 'measure-polylength': 'Polylength', 'measure-area': 'Area', 'measure-radius': 'Radius', count: 'Count marker' } as const)[t]
}

/** Compact style editor for the style chip: color, fill, width and opacity of the style new markups get. */
export function QuickStyle({ style, onChange }: { style: MarkupStyle; onChange: (s: MarkupStyle) => void }) {
  const set = (patch: Partial<MarkupStyle>) => onChange({ ...style, ...patch })
  return (
    <div className="stack quick-style">
      <div className="field">Color
        <div className="swatches">
          {SWATCHES.map(c => <button key={c} className={`swatch${style.stroke === c ? ' on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => set({ stroke: c })} />)}
          <input type="color" aria-label="Custom color" value={style.stroke || '#000000'} onChange={e => set({ stroke: e.target.value })} />
        </div>
      </div>
      <div className="field">Fill
        <div className="swatches">
          <button className={`swatch none${!style.fill ? ' on' : ''}`} aria-label="No fill" onClick={() => set({ fill: '' })} />
          {SWATCHES.slice(0, 6).map(c => <button key={c} className={`swatch${style.fill === c ? ' on' : ''}`} style={{ background: c }} aria-label={`fill ${c}`} onClick={() => set({ fill: c })} />)}
          <input type="color" aria-label="Custom fill" value={style.fill || '#ffffff'} onChange={e => set({ fill: e.target.value })} />
        </div>
      </div>
      <label className="field">Line width <span className="muted">{style.strokeWidth}</span>
        <input type="range" min={0.5} max={20} step={0.5} value={style.strokeWidth} onChange={e => set({ strokeWidth: +e.target.value })} />
      </label>
      <label className="field">Opacity <span className="muted">{Math.round(style.opacity * 100)}%</span>
        <input type="range" min={0.1} max={1} step={0.05} value={style.opacity} onChange={e => set({ opacity: +e.target.value })} />
      </label>
    </div>
  )
}
