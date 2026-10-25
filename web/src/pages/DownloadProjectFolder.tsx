import { useState } from 'react'
import { api, authFetch } from '../api'

/**
 * Ask the server whether the zip can be made (headers only; the body is dropped) so a refusal such as 413 "too large"
 * or 429 "slow down" is shown here instead of replacing the app with a bare JSON error page.
 */
export async function probeFolderZip(url: string): Promise<string | null> {
  const ctl = new AbortController()
  try {
    const res = await authFetch(url, { signal: ctl.signal })
    if (res.ok) return null
    const body = await res.json().catch(() => ({})) as { error?: string }
    return body.error || (res.status === 429 ? 'Too many downloads right now. Try again in a minute.' : `The download failed (${res.status})`)
  } catch (e) { return (e as Error).name === 'AbortError' ? null : 'Could not reach the server' } finally { ctl.abort() }
}

/** Starts the folder-zip download; resolves to an error message, or null when the browser took over. */
export async function startFolderDownload(projectId: string): Promise<string | null> {
  try {
    const base = `/api/projects/${encodeURIComponent(projectId)}/folder.zip`
    const refused = await probeFolderZip(base)
    if (refused) return refused
    const { ft } = await api<{ ft: string }>('/file-token', { method: 'POST' })
    const a = document.createElement('a')
    a.href = `${base}?ft=${encodeURIComponent(ft)}`
    a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
    return null
  } catch (e) { return (e as Error).message }
}

/**
 * Downloads the project as a zip in the same folder layout as on the file share (plans, photos, report logo and a device list).
 * A short-lived file token lets the browser stream the zip straight to disk instead of holding it in memory.
 */
export function DownloadProjectFolder({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function download() {
    setBusy(true); setErr('')
    try {
      const base = `/api/projects/${encodeURIComponent(projectId)}/folder.zip`
      const refused = await probeFolderZip(base)
      if (refused) { setErr(refused); return }
      const { ft } = await api<{ ft: string }>('/file-token', { method: 'POST' })
      const a = document.createElement('a')
      a.href = `${base}?ft=${encodeURIComponent(ft)}`
      a.rel = 'noopener'
      document.body.appendChild(a); a.click(); a.remove()
    } catch (e) { setErr((e as Error).message) } finally { setTimeout(() => setBusy(false), 1500) }
  }

  return (
    <>
      <button type="button" disabled={disabled || busy} onClick={download}
        title="A zip of the project's plans, photos and device list, in the same folders as on the file share">
        {busy ? 'Preparing…' : 'Download project folder'}
      </button>
      {err && <span className="error small" role="alert"> {err}</span>}
    </>
  )
}
