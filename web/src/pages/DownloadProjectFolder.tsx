import { useState } from 'react'
import { api } from '../api'

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
      const { ft } = await api<{ ft: string }>('/file-token', { method: 'POST' })
      const a = document.createElement('a')
      a.href = `/api/projects/${encodeURIComponent(projectId)}/folder.zip?ft=${encodeURIComponent(ft)}`
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
