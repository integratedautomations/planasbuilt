import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface Pending { message: string; confirmLabel: string }

/**
 * In-app replacement for window.confirm (which blocks the page and is suppressed in some browsers/automation).
 * Render `dialog` somewhere in the component; `ask(message)` resolves true on confirm, false on cancel.
 */
export function useConfirm(): { ask: (message: string, confirmLabel?: string) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const ask = useCallback((message: string, confirmLabel = 'Confirm') => new Promise<boolean>(resolve => {
    resolver.current?.(false)
    resolver.current = resolve
    setPending({ message, confirmLabel })
  }), [])
  const close = (ok: boolean) => { resolver.current?.(ok); resolver.current = null; setPending(null) }
  const dialog = pending && (
    <div className="name-modal" role="alertdialog" aria-modal="true" aria-label="Confirm" onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Escape') close(false) }}>
      <div>
        <p>{pending.message}</p>
        <div className="row">
          <button type="button" autoFocus onClick={() => close(false)}>Cancel</button>
          <button type="button" className="danger" onClick={() => close(true)}>{pending.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
  return { ask, dialog }
}
