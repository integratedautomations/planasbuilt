import { useEffect, useState } from 'react'
import { comboFromEvent, commandLabel, formatCombo, recordCombo } from './hotkeys'

interface Props {
  /** Command being bound, and its name for display. */
  commandId: string
  label: string
  overrides: Record<string, string>
  /** Names clashing commands when they are not in the static registry (dynamic tool commands). */
  nameOf?: (commandId: string) => string
  onChange: (o: Record<string, string>) => void
  onClose: () => void
}

/** Small "press the keys" prompt for one command; a clash asks before taking the combo away from the other command. */
export function HotkeyRecorder({ commandId, label, overrides, nameOf, onChange, onClose }: Props) {
  const [pending, setPending] = useState<{ combo: string; conflicts: string[]; overrides: Record<string, string> } | null>(null)

  useEffect(() => {
    if (pending) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { onClose(); return }
      const combo = comboFromEvent(e)
      if (!combo) return // bare modifier: keep waiting
      const r = recordCombo(overrides, commandId, combo)
      if (r.conflicts.length) setPending({ combo, conflicts: r.conflicts, overrides: r.overrides })
      else { onChange(r.overrides); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending, overrides, commandId, onChange, onClose])

  const name = (id: string) => nameOf?.(id) ?? commandLabel(id)
  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <div className="hotkey-recorder" role="dialog" aria-label={`Assign hotkey to ${label}`}>
        <div className="panel-heading">Hotkey for {label}</div>
        {pending ? (
          <div className="hotkey-warn" role="alert">
            {formatCombo(pending.combo)} is already used by {pending.conflicts.map(name).join(', ')}.
            <button onClick={() => { onChange(pending.overrides); onClose() }}>Reassign to {label}</button>
            <button onClick={onClose}>Cancel</button>
          </div>
        ) : (
          <p className="hotkey-prompt">Press the keys… <span className="muted small">(Esc cancels)</span></p>
        )}
        {!pending && <div className="row"><span className="spacer" /><button onClick={onClose}>Cancel</button></div>}
      </div>
    </div>
  )
}
