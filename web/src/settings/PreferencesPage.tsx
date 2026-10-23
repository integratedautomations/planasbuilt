import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Brand } from '../Brand'
import { OfflineBanner } from '../offline/OfflineBanner'
import { UserMenu } from './UserMenu'
import { HotkeyDialog } from '../prefs/HotkeyDialog'
import { DENSITY_PREFS } from '../prefs/density'
import type { DensityPref } from '../prefs/density'
import { THEME_PREFS } from '../prefs/theme'
import type { ThemePref } from '../prefs/theme'
import { setPref, usePrefs } from '../prefs/store'
import {
  COVERAGE_OPACITY_MAX, COVERAGE_OPACITY_MIN, LONG_PRESS_MAX, LONG_PRESS_MIN, WHEEL_SPEED_MAX, WHEEL_SPEED_MIN,
} from '../prefs/general'
import type { AfterPlace, GeneralPrefs, LabelMode, OpenAt, PencilMode, RotateStep } from '../prefs/general'
import type { ReplaceChoice } from '../markups/placeReplace'
import { SnapControls, HoldDelayField } from '../viewer/SnapMenu'
import { formatLength, UNIT_MODES, UNIT_ROUNDS } from '../units'
import type { UnitMode, UnitRound } from '../units'

const THEME_LABEL: Record<ThemePref, string> = { auto: 'Match my device', light: 'Light', dark: 'Dark' }
const DENSITY_LABEL: Record<DensityPref, string> = { auto: 'Automatic (compact on desktop, comfortable on touch)', compact: 'Compact', comfortable: 'Comfortable' }
const UNIT_LABEL: Record<UnitMode, string> = { ftin: "Feet and inches (12'-6\")", decimal: 'Decimal feet (12.50 ft)' }
const ROUND_LABEL: Record<UnitRound, string> = { 1: 'Nearest inch', 2: 'Nearest 1/2 inch', 4: 'Nearest 1/4 inch' }

const setGeneral = (cur: GeneralPrefs, patch: Partial<GeneralPrefs>) => setPref('general', { ...cur, ...patch })

function Check({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="snap-row" title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="card settings-card" id={id} aria-labelledby={`${id}-h`}><h3 id={`${id}-h`}>{title}</h3>{children}</section>
}

/** Personal preferences, one page: placing, viewing, touch, notifications, snapping and hotkeys. Everything follows the user to every device. */
export function PreferencesPage() {
  const prefs = usePrefs()
  const g = prefs.general
  const [hotkeys, setHotkeys] = useState(false)
  const set = (patch: Partial<GeneralPrefs>) => setGeneral(g, patch)
  const sample = formatLength(12 + 6.37 / 12, prefs.units)
  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="PlanAsBuilt"><Brand onChrome /></Link>
        <span className="muted">/</span>
        <span className="crumb">Preferences</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <OfflineBanner />
      <main className="content content-wide settings-page">
        <h2>Preferences</h2>
        <p className="muted small">These follow you to every device you sign in on. Profile and password are under <Link to="/settings">Settings</Link>.</p>
        <div className="settings-grid">
          <Section id="pref-placing" title="Placing">
            <label className="field">After placing a device
              <select value={g.afterPlace} onChange={e => set({ afterPlace: e.target.value as AfterPlace })}>
                <option value="stay">Stay on the device tool</option>
                <option value="select">Go back to Select</option>
              </select>
            </label>
            <label className="field">When I place a device on a device of another type
              <select value={prefs.replaceOnOverlap} onChange={e => setPref('replaceOnOverlap', e.target.value as ReplaceChoice)}>
                <option value="ask">Ask me</option>
                <option value="replace">Replace it</option>
                <option value="both">Place both</option>
              </select>
            </label>
            <label className="field">Hold-to-rotate step
              <select value={g.rotateStep} onChange={e => set({ rotateStep: Number(e.target.value) as RotateStep })}>
                <option value={15}>15 degrees</option>
                <option value={5}>5 degrees</option>
                <option value={0}>Off (free rotation)</option>
              </select>
            </label>
            <HoldDelayField />
            <Check label="Ask before deleting several markups at once" checked={g.confirmMultiDelete} onChange={v => set({ confirmMultiDelete: v })} />
            <p className="muted small">Default device size is set per plan (device size control in the viewer). Tag format and numbering are project settings.</p>
          </Section>

          <Section id="pref-viewing" title="Viewing">
            <label className="field">Device labels
              <select value={g.labels} onChange={e => set({ labels: e.target.value as LabelMode })}>
                <option value="always">Always</option>
                <option value="zoomed">Only when zoomed in</option>
                <option value="never">Never</option>
              </select>
            </label>
            <Check label="Show coverage by default" hint="Applies to projects where you have not switched coverage on or off yourself" checked={g.coverageDefault} onChange={v => set({ coverageDefault: v })} />
            <label className="field">Coverage opacity {g.coverageOpacity === null ? <span className="muted">(default)</span> : <span className="muted">{Math.round(g.coverageOpacity * 100)}%</span>}
              <div className="row">
                <input type="range" min={Math.round(COVERAGE_OPACITY_MIN * 100)} max={Math.round(COVERAGE_OPACITY_MAX * 100)} step={1}
                  value={Math.round((g.coverageOpacity ?? 0.18) * 100)} aria-label="Coverage opacity"
                  onChange={e => set({ coverageOpacity: Number(e.target.value) / 100 })} />
                {g.coverageOpacity !== null && <button type="button" onClick={() => set({ coverageOpacity: null })}>Reset</button>}
              </div>
            </label>
            <Check label="Show other people's cursors" checked={g.showCursors} onChange={v => set({ showCursors: v })} />
            <Check label="Show other people's view rectangles" checked={g.showViewRects} onChange={v => set({ showViewRects: v })} />
            <Check label="Show other people's selections" checked={g.showSelections} onChange={v => set({ showSelections: v })} />
            <label className="field">Length units
              <select value={prefs.units.mode} onChange={e => setPref('units', { ...prefs.units, mode: e.target.value as UnitMode })}>
                {UNIT_MODES.map(m => <option key={m} value={m}>{UNIT_LABEL[m]}</option>)}
              </select>
            </label>
            <label className="field">Round lengths to
              <select value={prefs.units.round} onChange={e => setPref('units', { ...prefs.units, round: Number(e.target.value) as UnitRound })}>
                {UNIT_ROUNDS.map(r => <option key={r} value={r}>{ROUND_LABEL[r]}</option>)}
              </select>
              <span className="muted small">Example: {sample}. Applies to the canvas, totals, exports and reports you make.</span>
            </label>
            <label className="field">Theme
              <select value={prefs.theme} onChange={e => setPref('theme', e.target.value as ThemePref)}>
                {THEME_PREFS.map(t => <option key={t} value={t}>{THEME_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="field">Density
              <select value={prefs.density} onChange={e => setPref('density', e.target.value as DensityPref)}>
                {DENSITY_PREFS.map(d => <option key={d} value={d}>{DENSITY_LABEL[d]}</option>)}
              </select>
            </label>
            <label className="field">Wheel zoom speed <span className="muted">{g.wheelSpeed.toFixed(2)}x</span>
              <input type="range" min={WHEEL_SPEED_MIN} max={WHEEL_SPEED_MAX} step={0.25} value={g.wheelSpeed} aria-label="Wheel zoom speed"
                onChange={e => set({ wheelSpeed: Number(e.target.value) })} />
            </label>
            <Check label="Middle mouse button pans" checked={g.middlePan} onChange={v => set({ middlePan: v })} />
            <label className="field">Open plans at
              <select value={g.openAt} onChange={e => set({ openAt: e.target.value as OpenAt })}>
                <option value="fit">Fit page</option>
                <option value="last">The last view on this device</option>
              </select>
            </label>
          </Section>

          <Section id="pref-touch" title="Touch">
            <label className="field">Long-press time for the context menu <span className="muted">{g.longPressMs} ms</span>
              <input type="range" min={LONG_PRESS_MIN} max={LONG_PRESS_MAX} step={50} value={g.longPressMs} aria-label="Long-press time"
                onChange={e => set({ longPressMs: Number(e.target.value) })} />
            </label>
            <label className="field">Apple Pencil on empty space
              <select value={g.pencil} onChange={e => set({ pencil: e.target.value as PencilMode })}>
                <option value="box">Drags a selection box</option>
                <option value="draw">Draws or pans directly</option>
              </select>
            </label>
            <Check label="Haptic feedback on snap and place" hint="Where the device supports vibration" checked={g.haptics} onChange={v => set({ haptics: v })} />
          </Section>

          <Section id="pref-notifications" title="Notifications">
            <p className="muted small">Coming soon: there is no notification system yet, so these cannot be switched on.</p>
            <Check label="Someone edits my plan" checked={false} disabled onChange={() => {}} />
            <Check label="A backup fails" checked={false} disabled onChange={() => {}} />
            <Check label="I am added to a project" checked={false} disabled onChange={() => {}} />
          </Section>

          <Section id="pref-snapping" title="Snapping">
            <SnapControls hasScale holdDelay={false} />
          </Section>

          <Section id="pref-hotkeys" title="Hotkeys">
            <p className="muted small">Change the keyboard shortcut for any command, or clear it.</p>
            <div><button onClick={() => setHotkeys(true)}>Edit keyboard shortcuts…</button></div>
          </Section>
        </div>
        {hotkeys && <HotkeyDialog overrides={prefs.hotkeys} onChange={o => setPref('hotkeys', o)} onClose={() => setHotkeys(false)}
          replaceChoice={prefs.replaceOnOverlap} onReplaceChoice={c => setPref('replaceOnOverlap', c)} />}
      </main>
    </div>
  )
}
