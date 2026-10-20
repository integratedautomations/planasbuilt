import { FormEvent, useRef, useState } from 'react'
import { api, companyLogoUrl } from '../api'
import type { CompanyInfo } from '../api'
import { useAuthedUrl } from '../useAuthedUrl'
import { setCompanyCache } from './company'
import type { AdminSettings } from './types'
import { useAdminSettings } from './useAdminSettings'

export function CompanyTab() {
  const { settings, setSettings, error, save } = useAdminSettings()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [logoVersion, setLogoVersion] = useState(0)
  const file = useRef<HTMLInputElement>(null)
  const logoUrl = useAuthedUrl(settings?.company.has_logo ? companyLogoUrl(logoVersion) : undefined)
  if (!settings) return <p className="muted">{error || 'Loading…'}</p>
  const s = settings

  const patch = (p: Partial<AdminSettings['company']>) => setSettings({ ...s, company: { ...s.company, ...p } })

  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(''); setErr('')
    try {
      await save({
        company: { name: s.company.name, address: s.company.address, phone: s.company.phone, prepared_by: s.company.prepared_by },
        tags: { padding: s.tags.padding },
        photos: { max_dimension: s.photos.max_dimension },
      })
      setMsg('Saved')
    } catch (e2) { setErr((e2 as Error).message) }
  }

  async function uploadLogo(f: File | undefined) {
    if (file.current) file.current.value = ''
    if (!f) return
    setErr('')
    try {
      const form = new FormData()
      form.append('file', f)
      const info = await api<CompanyInfo>('/settings/logo', { method: 'POST', body: form })
      setCompanyCache(info)
      setSettings({ ...s, company: { ...s.company, has_logo: info.has_logo, logo_type: info.logo_type } })
      setLogoVersion(v => v + 1)
    } catch (e2) { setErr((e2 as Error).message) }
  }

  async function removeLogo() {
    setErr('')
    try {
      const info = await api<CompanyInfo>('/settings/logo', { method: 'DELETE' })
      setCompanyCache(info)
      setSettings({ ...s, company: { ...s.company, has_logo: false, logo_type: '' } })
    } catch (e2) { setErr((e2 as Error).message) }
  }

  return (
    <form className="settings-grid" onSubmit={submit}>
      <section className="card settings-card">
        <h3>Company</h3>
        <label className="field">Company name<input value={s.company.name} onChange={e => patch({ name: e.target.value })} /></label>
        <label className="field">Address<textarea rows={3} value={s.company.address} onChange={e => patch({ address: e.target.value })} /></label>
        <label className="field">Phone<input value={s.company.phone} onChange={e => patch({ phone: e.target.value })} /></label>
        <div className="field">Logo (PNG or SVG, 1 MB max)
          <div className="row">
            {s.company.has_logo
              ? <img className="logo-preview" alt="Company logo" src={logoUrl || undefined} />
              : <span className="muted small">No logo yet</span>}
            <input ref={file} type="file" accept="image/png,image/svg+xml,.png,.svg" hidden onChange={e => uploadLogo(e.target.files?.[0])} />
            <button type="button" onClick={() => file.current?.click()}>{s.company.has_logo ? 'Replace' : 'Upload'}</button>
            {s.company.has_logo && <button type="button" className="danger" onClick={removeLogo}>Remove</button>}
          </div>
        </div>
      </section>

      <section className="card settings-card">
        <h3>Report defaults</h3>
        <p className="muted small">Filled into the as-built report title page. People can still change them for each report.</p>
        <label className="field">Prepared by<input value={s.company.prepared_by} onChange={e => patch({ prepared_by: e.target.value })} placeholder="e.g. Field Services Team" /></label>
        <p className="muted small">The report also uses the company name and address above.</p>
      </section>

      <section className="card settings-card">
        <h3>Tags</h3>
        <label className="field">Tag number digits
          <select value={s.tags.padding} onChange={e => setSettings({ ...s, tags: { padding: Number(e.target.value) as 2 | 3 | 4 } })}>
            <option value={2}>2 digits (CAM-01)</option>
            <option value={3}>3 digits (CAM-001)</option>
            <option value={4}>4 digits (CAM-0001)</option>
          </select>
        </label>
        <p className="muted small">Applies to tags created from now on; existing tags are not renamed. Status names stay fixed for now.</p>
      </section>

      <section className="card settings-card">
        <h3>Photos</h3>
        <label className="field">Longest side (pixels)
          <input type="number" min={800} max={6000} step={100} value={s.photos.max_dimension}
            onChange={e => setSettings({ ...s, photos: { max_dimension: Number(e.target.value) } })} />
        </label>
        <p className="muted small">Photos are shrunk to this size on the phone before uploading. 2000 is a good balance.</p>
      </section>

      <div className="settings-actions">
        {err && <div className="error">{err}</div>}
        <div className="row"><button className="primary">Save changes</button>{msg && <span className="muted small" role="status">{msg}</span>}</div>
      </div>
    </form>
  )
}
