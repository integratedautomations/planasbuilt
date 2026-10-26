import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Project } from '../api'
import { cableSettings } from '../markups/cables'
import { applyProjectSettings, normalizeSettings } from '../projectSettings'

/** Project cable defaults: slack added to every drawn run and the drop added at each end locked to a device. Cables can override both. */
export function CableDefaults({ project, canEdit, onSaved }: { project: Project; canEdit: boolean; onSaved: (p: Project) => void }) {
  const viaDrop = normalizeSettings(project.settings).cable_via_drop
  const cur = cableSettings(project)
  const [slack, setSlack] = useState(String(cur.slackPct))
  const [drop, setDrop] = useState(String(cur.dropFt))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setSlack(String(cur.slackPct)); setDrop(String(cur.dropFt)) }, [cur.slackPct, cur.dropFt]) // eslint-disable-line react-hooks/exhaustive-deps
  const s = Number(slack), d = Number(drop)
  const valid = slack.trim() !== '' && drop.trim() !== '' && Number.isFinite(s) && s >= 0 && s <= 1000 && Number.isFinite(d) && d >= 0 && d <= 10000
  const dirty = valid && (s !== cur.slackPct || d !== cur.dropFt)

  async function save() {
    setBusy(true); setError('')
    try {
      const p = await api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ cable_slack_pct: s, cable_drop_ft: d }) })
      onSaved({ ...project, cable_slack_pct: p.cable_slack_pct, cable_drop_ft: p.cable_drop_ft })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function setMode(mode: 'daisy' | 'home') {
    setBusy(true); setError('')
    try {
      const next = await api<unknown>(`/projects/${project.id}/settings`, { method: 'PUT', body: JSON.stringify({ cable_mode: mode }) })
      applyProjectSettings(next)
      onSaved({ ...project, settings: normalizeSettings(next) } as Project)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function setViaDrop(on: boolean) {
    setBusy(true); setError('')
    try {
      const next = await api<unknown>(`/projects/${project.id}/settings`, { method: 'PUT', body: JSON.stringify({ cable_via_drop: on }) })
      applyProjectSettings(next)
      onSaved({ ...project, settings: normalizeSettings(next) } as Project)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="pp-cable stack">
      <p className="muted small">A cable run's length = drawn length x (1 + slack %) + drop x ends locked to a device, times its run count. Each cable can override both in Properties.</p>
      <fieldset disabled={!canEdit || busy} className="row wrap">
        <label className="field inline">Slack %<input type="number" min={0} max={1000} step="any" value={slack} onChange={e => setSlack(e.target.value)} /></label>
        <label className="field inline">Drop per linked end, ft<input type="number" min={0} max={10000} step="any" value={drop} onChange={e => setDrop(e.target.value)} /></label>
        {canEdit && <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save cable defaults'}</button>}
      </fieldset>
      <label className="field">Measure cables as
        <select value={cur.mode ?? 'daisy'} disabled={!canEdit || busy} onChange={e => void setMode(e.target.value as 'daisy' | 'home')}>
          <option value="daisy">Daisy chain (drawn path once)</option>
          <option value="home">Home runs (a cable per device from the start)</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={viaDrop} disabled={!canEdit || busy} onChange={e => void setViaDrop(e.target.checked)} /> Add drop length at devices a cable passes through</label>
      <p className="muted small">A run clicked through devices counts each one like an end: one drop per device it passes through (on top of the two ends).</p>
      {error && <div className="error">{error}</div>}
    </div>
  )
}
