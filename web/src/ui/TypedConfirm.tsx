import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface Pending { title: string; message: string; expected: string[]; confirmLabel: string; hint: string }
export interface TypedConfirmOptions {
  title: string
  message: string
  /** What the person must type (any one of these, compared exactly after trimming). */
  expected: string[]
  confirmLabel?: string
}

/**
 * Like useConfirm, but the action stays disabled until the person types one of `expected` (a project's name, a user's email).
 * `ask(...)` resolves true on confirm, false on cancel.
 */
export function useTypedConfirm(): { ask: (o: TypedConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null)
  const [typed, setTyped] = useState('')
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const ask = useCallback((o: TypedConfirmOptions) => new Promise<boolean>(resolve => {
    resolver.current?.(false)
    resolver.current = resolve
    setTyped('')
    setPending({ title: o.title, message: o.message, expected: o.expected, confirmLabel: o.confirmLabel ?? 'Delete', hint: o.expected.join(' or ') })
  }), [])
  const close = (ok: boolean) => { resolver.current?.(ok); resolver.current = null; setPending(null) }
  const matches = !!pending && pending.expected.some(e => typed.trim() === e.trim())
  const dialog = pending && (
    <div className="name-modal" role="alertdialog" aria-modal="true" aria-label={pending.title} onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Escape') close(false) }}>
      <form onSubmit={e => { e.preventDefault(); if (matches) close(true) }}>
        <h3>{pending.title}</h3>
        <p>{pending.message}</p>
        <label className="small">Type <strong>{pending.hint}</strong> to confirm
          <input autoFocus value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Confirmation" />
        </label>
        <div className="row">
          <button type="button" onClick={() => close(false)}>Cancel</button>
          <button type="submit" className="danger" disabled={!matches}>{pending.confirmLabel}</button>
        </div>
      </form>
    </div>
  )
  return { ask, dialog }
}
