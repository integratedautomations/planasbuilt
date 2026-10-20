import { useEffect, useState } from 'react'
import { assignCombo, comboFromEvent, COMMANDS, commandLabel, findConflicts, formatCombo, DEFAULT_HOTKEYS, resetCombo, resolveHotkeys } from './hotkeys'

import type { ReplaceChoice } from '../markups/placeReplace'

interface Props {
  overrides: Record<string, string>; onChange: (o: Record<string, string>) => void; onClose: () => void
  /** What happens when a device is placed on a device of another type. */
  replaceChoice?: ReplaceChoice; onReplaceChoice?: (c: ReplaceChoice) => void
}

/** Lists every command with its hotkey. Click a combo, press the new keys; a clash asks before reassigning. */
export function HotkeyDialog({ overrides, onChange, onClose, replaceChoice, onReplaceChoice }: Props) {
  const [recording, setRecording] = useState<string | null>(null)
  const [pending, setPending] = useState<{ id: string; combo: string; conflicts: string[] } | null>(null)
  const [filter, setFilter] = useState('')
  const map = resolveHotkeys(overrides)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      const combo = comboFromEvent(e)
      if (!combo) return // bare modifier: keep waiting
      const conflicts = findConflicts(map, recording, combo)
      if (conflicts.length) setPending({ id: recording, combo, conflicts })
      else onChange(assignCombo(overrides, recording, combo))
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, map, overrides, onChange])

  useEffect(() => {
    if (recording || pending) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [recording, pending, onClose])

  const q = filter.trim().toLowerCase()
  const groups = [...new Set(COMMANDS.map(c => c.group))]
  const dirty = Object.keys(overrides).length > 0

  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <div className="hotkey-dialog" role="dialog" aria-label="Keyboard shortcuts">
        <div className="hotkey-head">
          <strong className="panel-heading">Keyboard shortcuts</strong>
          <input type="search" placeholder="Filter" aria-label="Filter commands" value={filter} onChange={e => setFilter(e.target.value)} />
          <span className="spacer" />
          <button onClick={() => { if (window.confirm('Restore every shortcut to its default?')) onChange({}) }} disabled={!dirty}>Restore Defaults</button>
          <button onClick={onClose}>Done</button>
        </div>
        {replaceChoice && onReplaceChoice && (
          <label className="field hotkey-pref">Placing a device on a different device type
            <select value={replaceChoice} onChange={e => onReplaceChoice(e.target.value as ReplaceChoice)}>
              <option value="ask">Ask me</option>
              <option value="replace">Replace it</option>
              <option value="both">Place both</option>
            </select>
          </label>
        )}
        {pending && (
          <div className="hotkey-warn" role="alert">
            {formatCombo(pending.combo)} is already used by {pending.conflicts.map(commandLabel).join(', ')}.
            <button onClick={() => { onChange(assignCombo(overrides, pending.id, pending.combo)); setPending(null) }}>Reassign to {commandLabel(pending.id)}</button>
            <button onClick={() => setPending(null)}>Cancel</button>
          </div>
        )}
        <div className="hotkey-scroll">
          {groups.map(g => {
            const cmds = COMMANDS.filter(c => c.group === g && (!q || c.label.toLowerCase().includes(q) || (map[c.id] ?? '').toLowerCase().includes(q)))
            if (!cmds.length) return null
            return (
              <section key={g}>
                <div className="chest-heading">{g}</div>
                {cmds.map(c => {
                  const changed = map[c.id] !== DEFAULT_HOTKEYS[c.id]
                  return (
                    <div key={c.id} className="hotkey-row">
                      <span className="hotkey-name">{c.label}</span>
                      <button className={`hotkey-combo${recording === c.id ? ' recording' : ''}${changed ? ' changed' : ''}`}
                        onClick={() => { setPending(null); setRecording(c.id) }} title="Click, then press the new keys (Esc cancels)">
                        {recording === c.id ? 'Press keys…' : formatCombo(map[c.id])}
                      </button>
                      <button className="icon-btn small" disabled={!changed} onClick={() => onChange(resetCombo(overrides, c.id))} title={`Reset to ${formatCombo(DEFAULT_HOTKEYS[c.id])}`} aria-label={`Reset ${c.label}`}>↺</button>
                      <button className="icon-btn small" disabled={!map[c.id]} onClick={() => onChange(assignCombo(overrides, c.id, ''))} title="Unassign" aria-label={`Unassign ${c.label}`}>✕</button>
                    </div>
                  )
                })}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
