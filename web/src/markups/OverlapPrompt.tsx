import { useState } from 'react'

interface Props {
  message: string
  onChoose: (choice: 'replace' | 'both' | 'cancel', remember: boolean) => void
}

/** Asked when a device is placed on a device of another type: replace it, keep both, or cancel the placement. */
export function OverlapPrompt({ message, onChoose }: Props) {
  const [remember, setRemember] = useState(false)
  return (
    <div className="name-modal" onPointerDown={e => e.stopPropagation()}>
      <form role="dialog" aria-label="Replace device" onSubmit={e => { e.preventDefault(); onChoose('replace', remember) }}
        onKeyDown={e => { if (e.key === 'Escape') onChoose('cancel', false) }}>
        <div className="panel-heading">{message}</div>
        <label className="check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Don't ask again</label>
        <p className="muted small">You can change this later under Keyboard shortcuts.</p>
        <div className="row">
          <button type="button" onClick={() => onChoose('cancel', false)}>Cancel</button>
          <span className="spacer" />
          <button type="button" onClick={() => onChoose('both', remember)}>Place both</button>
          <button type="submit" className="primary" autoFocus>Replace</button>
        </div>
      </form>
    </div>
  )
}
