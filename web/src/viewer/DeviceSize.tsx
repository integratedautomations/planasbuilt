import { clampDeviceScale, DEVICE_SCALE_MAX, DEVICE_SCALE_MIN, DEVICE_SCALE_STEP } from '../markups/deviceScale'

interface Props {
  value: number
  /** Viewers see the size but cannot change it. */
  readOnly?: boolean
  onChange: (v: number) => void
}

export const formatDeviceScale = (v: number) => `${Math.round(v * 100)}%`

/** Slider with minus / plus / Reset for the plan's device size multiplier. */
export function DeviceSizeControl({ value, readOnly, onChange }: Props) {
  const set = (v: number) => onChange(clampDeviceScale(v))
  return (
    <div className="device-size">
      <div className="device-size-row">
        <button className="icon-btn small" disabled={readOnly || value <= DEVICE_SCALE_MIN} onClick={() => set(value - DEVICE_SCALE_STEP)} title="Smaller devices" aria-label="Smaller devices">&minus;</button>
        <input type="range" min={DEVICE_SCALE_MIN} max={DEVICE_SCALE_MAX} step={DEVICE_SCALE_STEP} value={value} disabled={readOnly}
          aria-label="Device size" onChange={e => set(Number(e.target.value))} />
        <button className="icon-btn small" disabled={readOnly || value >= DEVICE_SCALE_MAX} onClick={() => set(value + DEVICE_SCALE_STEP)} title="Bigger devices" aria-label="Bigger devices">+</button>
      </div>
      <div className="device-size-row">
        <strong>{formatDeviceScale(value)}</strong>
        <button disabled={readOnly || value === 1} onClick={() => set(1)}>Reset</button>
      </div>
      {readOnly && <p className="muted small">Only editors can change the device size.</p>}
    </div>
  )
}
