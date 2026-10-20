import { useRef, useState } from 'react'

/** Shows a one-time link with a Copy button. */
export function CopyLink({ link, note }: { link: string; note?: string }) {
  const [copied, setCopied] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  async function copy() {
    try { await navigator.clipboard.writeText(link) }
    catch { input.current?.select(); document.execCommand?.('copy') }
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="copy-link">
      <div className="row">
        <input ref={input} readOnly value={link} onFocus={e => e.currentTarget.select()} aria-label="Link" />
        <button className="primary" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </div>
  )
}
