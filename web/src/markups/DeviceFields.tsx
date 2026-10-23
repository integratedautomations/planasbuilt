import { HARDWARE_FIELDS, STATUSES } from './types'
import { defaultProductId, fieldDefsFor, productOptionLabel, productsFor, refillFields, tagPrefixFor } from '../catalog/catalog'
import { useCatalogContext } from '../catalog/useCatalog'
import { useEffect, useState } from 'react'
import { loadAttachments } from '../offline/cache'
import { useSyncStatus } from '../offline/hooks'
import { on as onSocket } from '../realtime/socket'
import { activeSettings, describeBlocked, describeMissing, gateStatus, missingForStatus } from '../projectSettings'
import { useProjectRole } from '../roleContext'
import { can } from '../roles'
import { Attribution, HistorySection } from './MarkupInfo'
import { DevicePhotos } from '../photos/DevicePhotos'
import { BarcodeScanner } from '../photos/BarcodeScanner'
import '../photos/photos.css'
import type { FieldDef, Fov, Markup, Status, SymbolSet } from './types'
import { commonField, commonValue, isUniqueFieldKey } from './mixed'
import { mountLabel, MOUNTS, resolveMount, withMount } from './mount'
import { clampAngle, COVERAGE_DEFAULT_PX, COVERAGE_OPACITY, formatRange, initialCoverage, normDeg, parseRange, rangeFeet, withRangeFeet } from './coverage'

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export const isValidIp = (v: string) => !v || IPV4.test(v.trim())

interface Props {
  devices: Markup[]
  set?: SymbolSet
  readOnly: boolean
  /** Field and sub roles: only fields, status, notes and photos may change; device type, product, mount, tag and coverage are locked. */
  limited?: boolean
  onUpdate: (patch: (m: Markup) => Markup, mergeKey: string) => void
  /** Computed area names (outermost first) for a single device; omitted for multi-select. */
  areaPath?: string[]
  /** Heading for multi-device mode (default "N devices"), e.g. "Stack of 6". */
  heading?: string
  /** points_per_foot of the page (null = not calibrated). */
  scale?: number | null
}

/** Device data entry: tag, install status, hardware fields and the symbol set's own fields. */
export function DeviceFields({ devices, set, readOnly, limited = false, onUpdate, areaPath, heading, scale = null }: Props) {
  const d = devices[0]
  const single = devices.length === 1
  // Required fields per status (project settings): a device missing one keeps its status and the message says what to fill in.
  const [statusMsg, setStatusMsg] = useState('')
  const [photoCounts, setPhotoCounts] = useState<Map<string, number>>(new Map())
  const [photoTick, setPhotoTick] = useState(0)
  const needsPhoto = Object.values(activeSettings().required).some(l => l.includes('photo'))
  const { pending } = useSyncStatus()
  const idsKey = devices.map(m => m.id).join(',')
  useEffect(() => setStatusMsg(''), [idsKey])
  useEffect(() => onSocket('attachments', msg => { if (msg.markupId === d.id || msg.markupId === '*') setPhotoTick(n => n + 1) }), [d.id])
  useEffect(() => {
    if (!needsPhoto || readOnly || devices.length !== 1) return
    let cancel = false
    loadAttachments(d.id).then(r => { if (!cancel) setPhotoCounts(new Map([[d.id, r.data.length]])) }).catch(() => {})
    return () => { cancel = true }
  }, [d.id, devices.length, needsPhoto, readOnly, pending, photoTick])
  const setStatus = (status: Status) => {
    const { allowed, blocked } = gateStatus(devices, status, () => defs, devices.length === 1 ? photoCounts : undefined)
    setStatusMsg(describeBlocked(status, blocked))
    if (!allowed.length) return
    const ok = new Set(allowed.map(m => m.id))
    onUpdate(m => (ok.has(m.id) ? { ...m, status } : m), 'status')
  }
  const setField = (key: string, value: string | number | boolean) =>
    onUpdate(m => ({ ...m, fields: { ...m.fields, [key]: value } }), `field.${key}.${single ? d.id : 'all'}`)
  /** Multi-device: the shared value when every device agrees, otherwise empty + "Mixed". */
  const shared = (key: string) => commonField(devices, key)
  const [scanKey, setScanKey] = useState<string | null>(null)
  const scanProps = (key: string) => (key === 'serial' || key === 'mac') && !readOnly ? { onScan: () => setScanKey(key) } : {}
  const onScanned = (text: string) => {
    if (!scanKey) return
    const t = text.trim()
    const hex = t.replace(/[^0-9a-fA-F]/g, '')
    const value = scanKey === 'mac' && /^([0-9a-fA-F]{2}[:\-.]?){5}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{12}$/.test(t) && hex.length === 12
      ? hex.toUpperCase().match(/../g)!.join(':') : t
    setField(scanKey, value)
    setScanKey(null)
  }
  const fov = 'width' in d.geometry ? d.geometry.fov : undefined
  const setFov = (fn: (cur: Fov | undefined) => Fov | undefined, key: string) =>
    onUpdate(m => {
      if (!('width' in m.geometry)) return m
      const next = fn(m.geometry.fov)
      const geometry = { ...m.geometry }
      if (next) geometry.fov = next; else delete geometry.fov
      return { ...m, geometry }
    }, key)
  const setMount = (v: string) => onUpdate(m => withMount(m, v), `mount.${single ? d.id : 'all'}`)
  const mountOf = commonValue(devices, m => ('width' in m.geometry ? m.geometry.mount ?? '' : undefined))
  const cat = useCatalogContext()
  const sameType = devices.every(m => (m.device_type_id ?? null) === (d.device_type_id ?? null))
  const dtype = sameType && d.device_type_id ? cat.types.get(d.device_type_id) : undefined
  const sameProduct = devices.every(m => (m.product_id ?? null) === (d.product_id ?? null))
  const typeOptions = set ? cat.typesBySet.get(set.id) ?? [] : []
  // Clients never see fields flagged internal.
  const role = useProjectRole()
  const defs = fieldDefsFor(set, dtype).filter(f => !f.internal || !role || can(role, 'internal.view'))
  const productList = sameType ? productsFor(cat, d.device_type_id) : []
  const curProduct = sameProduct && d.product_id ? cat.products.get(d.product_id) : undefined
  const setType = (typeId: string) => {
    const next = typeId ? cat.types.get(typeId) : undefined
    const pid = defaultProductId(cat, typeId || null)
    const prod = pid ? cat.products.get(pid) : undefined
    onUpdate(m => {
      const old = m.device_type_id ? cat.types.get(m.device_type_id) : undefined
      // A tag numbered from the old prefix is cleared so the server numbers it from the new one
      const oldP = tagPrefixFor(set, old), newP = tagPrefixFor(set, next)
      const renumber = newP !== oldP && new RegExp(`^${oldP}-\\d+$`).test(m.tag ?? '')
      return { ...m, device_type_id: typeId || null, product_id: pid, tag: renumber ? '' : m.tag, fields: refillFields(m.fields, prod) }
    }, `devtype.${single ? d.id : 'all'}`)
  }
  const setProduct = (productId: string) => {
    const prod = productId ? cat.products.get(productId) : undefined
    onUpdate(m => ({ ...m, product_id: productId || null, fields: prod ? refillFields(m.fields, prod) : m.fields }), `product.${single ? d.id : 'all'}`)
  }

  return (
    <>
    <fieldset disabled={readOnly} className="stack">
      <div className="device-head">
        <span className="set-icon" style={{ background: set?.color ?? '#868e96' }}>{set?.icon && <img src={set.icon} alt="" />}</span>
        <div>
          <div className="panel-heading">{single ? d.tag || 'New device' : heading ?? `${devices.length} devices`}</div>
          <div className="muted small">{[set?.name ?? 'Unknown set', dtype?.name].filter(Boolean).join(' › ')}</div>
          {single && <Attribution markup={d} />}
          {single && areaPath && areaPath.length > 0 && (
            <div className="area-path small" title="Area">{'📍'} {areaPath.join(' › ')}</div>
          )}
        </div>
      </div>

      {set && typeOptions.length > 0 && (
        <label className="field">Device type
          <select disabled={limited} value={sameType ? d.device_type_id ?? '' : '__mixed'} onChange={e => setType(e.target.value)}>
            {!sameType && <option value="__mixed" disabled>Mixed</option>}
            <option value="">—</option>
            {typeOptions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {sameType && d.device_type_id && (
        <label className="field">Product
          <select disabled={limited} value={sameProduct ? d.product_id ?? '' : '__mixed'} onChange={e => setProduct(e.target.value)}>
            {!sameProduct && <option value="__mixed" disabled>Mixed</option>}
            <option value="">Unassigned</option>
            {curProduct && !productList.includes(curProduct) && <option value={curProduct.id}>{productOptionLabel(curProduct)} (inactive)</option>}
            {productList.map(p => <option key={p.id} value={p.id}>{productOptionLabel(p)}</option>)}
          </select>
          {curProduct?.spec_url && /^https?:/i.test(curProduct.spec_url) && <a className="small" href={curProduct.spec_url} target="_blank" rel="noreferrer">Spec sheet</a>}
        </label>
      )}
      <label className="field">Mount
        <select disabled={limited} value={mountOf.mixed ? '__mixed' : mountOf.value ?? ''} onChange={e => setMount(e.target.value)}>
          {mountOf.mixed && <option value="__mixed" disabled>Mixed</option>}
          <option value="">{sameType ? `Type default (${mountLabel(resolveMount(dtype?.mount, null))})` : 'Type default'}</option>
          {MOUNTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <div className="field">Status
        <div className="status-buttons">
          {STATUSES.map(s => {
            const need = single && d.status !== s.value ? missingForStatus(s.value, d, defs, photoCounts.get(d.id) ?? null) : []
            return (
              <button key={s.value} className={(devices.every(m => m.status === s.value) ? 'on' : '') + (need.length ? ' needs' : '')}
                style={{ '--status': s.color } as React.CSSProperties} onClick={() => setStatus(s.value)}
                title={need.length ? describeMissing(s.value, need) : undefined}>
                <span className="dot" style={{ background: s.color }} />{s.label}
              </button>
            )
          })}
        </div>
        {single && !readOnly && (() => {
          const hints = STATUSES.filter(s => s.value !== d.status)
            .map(s => ({ s, need: missingForStatus(s.value, d, defs, photoCounts.get(d.id) ?? null) })).filter(h => h.need.length)
          return hints.length ? <div className="status-needs muted small">{hints.map(h => <div key={h.s.value}>{describeMissing(h.s.value, h.need)}</div>)}</div> : null
        })()}
        {statusMsg && <div className="error small" role="alert">{statusMsg}</div>}
      </div>

      {single && (
        <>
          <label className="field">Tag
            <input disabled={limited} value={d.tag ?? ''} onChange={e => onUpdate(m => ({ ...m, tag: e.target.value }), `tag.${d.id}`)} />
          </label>
          {defs.map(f => <FieldInput key={f.key} def={f} value={d.fields?.[f.key]} onChange={v => setField(f.key, v)} {...scanProps(f.key)} />)}
          <div className="muted small section-label">Hardware</div>
          {HARDWARE_FIELDS.map(f => <FieldInput key={f.key} def={f} value={d.fields?.[f.key]} onChange={v => setField(f.key, v)} {...scanProps(f.key)} />)}
          <label className="field">Notes
            <textarea rows={2} value={String(d.fields?.notes ?? '')} onChange={e => setField('notes', e.target.value)} />
          </label>
          <fieldset disabled={limited} className="stack">
          <div className="muted small section-label">Coverage</div>
          <label className="check"><input type="checkbox" checked={!!fov && !fov.hidden}
            onChange={e => {
              const on = e.target.checked
              setFov(cur => on
                ? (cur ? { ...cur, hidden: false } : initialCoverage(set, dtype?.coverage?.on ? dtype.coverage : { on: true, angle: 90, range_ft: 20 }, scale) ?? { ...COVERAGE_DEFAULT_PX })
                : cur ? { ...cur, hidden: true } : cur, `fovshow.${d.id}`)
            }} /> Show coverage</label>
          {fov && !fov.hidden && (
            <>
              <label className="check"><input type="checkbox" checked={!!fov.locked}
                onChange={e => setFov(cur => cur && { ...cur, locked: e.target.checked }, `fovlock.${d.id}`)} /> Lock coverage</label>
              {!fov.locked && <p className="muted small">Drag the white dot to aim and size it, the filled dot to change the angle.</p>}
              {scale ? (
                <label className="field">Range
                  <input key={`r${fov.rangeFt ?? fov.range}`} defaultValue={formatRange(rangeFeet(fov, scale) ?? 0)} disabled={fov.locked} placeholder={`e.g. 40'`}
                    onBlur={e => {
                      const ft = parseRange(e.target.value)
                      if (ft === null) { e.target.value = formatRange(rangeFeet(fov, scale) ?? 0); return }
                      setFov(cur => cur && withRangeFeet(cur, ft, scale), `fovrange.${d.id}`)
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                </label>
              ) : (
                <>
                  <p className="scale-warn small">Set scale to use real distances</p>
                  <label className="field">Range <span className="muted">{Math.round(fov.range)} pt</span>
                    <input type="range" min={10} max={1500} step={5} value={fov.range} disabled={fov.locked}
                      onChange={e => setFov(cur => cur && { ...cur, range: +e.target.value }, `fov.${d.id}`)} />
                  </label>
                </>
              )}
              <div className="grid2">
                <label className="field">Angle (1–360°)
                  <input type="number" min={1} max={360} step={1} value={Math.round(fov.angle)} disabled={fov.locked}
                    onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setFov(cur => cur && { ...cur, angle: clampAngle(v) }, `fov.${d.id}`) }} />
                </label>
                <label className="field">Rotation (°)
                  <input type="number" step={1} value={Math.round(fov.direction)} disabled={fov.locked}
                    onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setFov(cur => cur && { ...cur, direction: normDeg(v) }, `fov.${d.id}`) }} />
                </label>
              </div>
              <label className="field">Opacity <span className="muted">{Math.round((fov.opacity ?? COVERAGE_OPACITY) * 100)}%</span>
                <input type="range" min={5} max={60} step={1} value={Math.round((fov.opacity ?? COVERAGE_OPACITY) * 100)}
                  onChange={e => setFov(cur => cur && { ...cur, opacity: +e.target.value / 100 }, `fovop.${d.id}`)} />
              </label>
            </>
          )}
          </fieldset>
        </>
      )}
      {!single && (
        <>
          <label className="field">Tag
            <input value="" disabled placeholder="Multiple" readOnly />
          </label>
          {defs.map(f => {
            const sh = shared(f.key)
            return <FieldInput key={f.key} def={f} value={sh.mixed ? undefined : sh.value} mixed={sh.mixed} multiple={isUniqueFieldKey(f.key, f.type)} onChange={v => setField(f.key, v)} />
          })}
          <div className="muted small section-label">Hardware</div>
          {HARDWARE_FIELDS.map(f => {
            const sh = shared(f.key)
            return <FieldInput key={f.key} def={f} value={sh.mixed ? undefined : sh.value} mixed={sh.mixed} multiple={isUniqueFieldKey(f.key, f.type)} onChange={v => setField(f.key, v)} />
          })}
          <label className="field">Notes
            <textarea rows={2} value={shared('notes').mixed ? '' : String(shared('notes').value ?? '')} placeholder={shared('notes').mixed ? 'Mixed' : undefined} onChange={e => setField('notes', e.target.value)} />
          </label>
          <fieldset disabled={limited} className="stack">
          <div className="muted small section-label">Coverage</div>
          {(() => {
            const withFov = devices.filter(m => 'width' in m.geometry)
            const f = (get: (v: Fov) => string | number | boolean | undefined) => commonValue(withFov, m => { const v = 'width' in m.geometry ? m.geometry.fov : undefined; return v ? get(v) : undefined })
            const shown = f(v => !v.hidden), locked = f(v => !!v.locked), angle = f(v => Math.round(v.angle)), dir = f(v => Math.round(v.direction))
            const anyShown = withFov.some(m => 'width' in m.geometry && m.geometry.fov && !m.geometry.fov.hidden)
            return (
              <>
                <label className="check"><input type="checkbox" checked={shown.value === true} ref={el => { if (el) el.indeterminate = withFov.length > 0 && (shown.mixed || shown.count < withFov.length) }}
                  onChange={e => {
                    const on = e.target.checked
                    setFov(cur => on
                      ? (cur ? { ...cur, hidden: false } : initialCoverage(set, dtype?.coverage?.on ? dtype.coverage : { on: true, angle: 90, range_ft: 20 }, scale) ?? { ...COVERAGE_DEFAULT_PX })
                      : cur ? { ...cur, hidden: true } : cur, 'fovshow.all')
                  }} /> Show coverage</label>
                {anyShown && (
                  <>
                    <label className="check"><input type="checkbox" checked={locked.value === true} ref={el => { if (el) el.indeterminate = locked.mixed }}
                      onChange={e => setFov(cur => cur && { ...cur, locked: e.target.checked }, 'fovlock.all')} /> Lock coverage</label>
                    <div className="grid2">
                      <label className="field">Angle (1–360°)
                        <input type="number" min={1} max={360} step={1} value={angle.mixed ? '' : angle.value as number ?? ''} placeholder={angle.mixed ? 'Mixed' : undefined}
                          onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setFov(cur => cur && !cur.locked ? { ...cur, angle: clampAngle(v) } : cur, 'fov.all') }} />
                      </label>
                      <label className="field">Rotation (°)
                        <input type="number" step={1} value={dir.mixed ? '' : dir.value as number ?? ''} placeholder={dir.mixed ? 'Mixed' : undefined}
                          onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setFov(cur => cur && !cur.locked ? { ...cur, direction: normDeg(v) } : cur, 'fov.all') }} />
                      </label>
                    </div>
                  </>
                )}
              </>
            )
          })()}
          </fieldset>
        </>
      )}
      {scanKey && <BarcodeScanner onResult={onScanned} onClose={() => setScanKey(null)} />}
    </fieldset>
    {/* Outside the disabled fieldset so viewers can still open and browse photos */}
    {single && (
      <div className="stack">
        <div className="muted small section-label">Photos</div>
        <DevicePhotos markupId={d.id} readOnly={readOnly} />
      </div>
    )}
    {single && <HistorySection markup={d} set={set} />}
    </>
  )
}

function FieldInput({ def, value, onChange, onScan, mixed, multiple }: { multiple?: boolean; def: FieldDef; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void; onScan?: () => void; mixed?: boolean }) {
  if (multiple) {
    return <label className="field">{def.label}<input value="" disabled readOnly placeholder="Multiple" /></label>
  }
  if (def.type === 'checkbox') {
    return <label className="check"><input type="checkbox" checked={!!value} ref={el => { if (el) el.indeterminate = !!mixed }} onChange={e => onChange(e.target.checked)} /> {def.label}{mixed ? ' (Mixed)' : ''}</label>
  }
  if (def.type === 'select') {
    return (
      <label className="field">{def.label}
        <select value={String(value ?? '')} onChange={e => onChange(e.target.value)}>
          <option value="">{mixed ? 'Mixed' : '—'}</option>
          {(def.options ?? []).map(o => <option key={o}>{o}</option>)}
        </select>
      </label>
    )
  }
  const v = String(value ?? '')
  const bad = def.type === 'ip' && !isValidIp(v)
  return (
    <label className="field">{def.label}
      <span className="input-row">
      <input className={bad ? 'invalid' : ''} value={v}
        type={def.type === 'date' ? 'date' : 'text'}
        inputMode={def.type === 'number' ? 'numeric' : def.type === 'ip' ? 'decimal' : undefined}
        placeholder={mixed ? 'Mixed' : def.type === 'ip' ? '192.168.1.10' : undefined}
        onChange={e => onChange(def.type === 'number' && e.target.value !== '' && !isNaN(+e.target.value) ? +e.target.value : e.target.value)} />
      {onScan && <button type="button" className="scan-btn" onClick={onScan} aria-label={`Scan ${def.label}`} title="Scan barcode">Scan</button>}
      </span>
      {bad && <span className="hint-bad">Not a valid IPv4 address</span>}
    </label>
  )
}
