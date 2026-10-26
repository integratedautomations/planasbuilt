import { FormEvent, useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { api, companyLogoUrl } from '../api'
import type { CompanyInfo } from '../api'
import { useAuthedUrl } from '../useAuthedUrl'
import type { SymbolSet } from '../markups/types'
import { loadSymbolSets } from '../offline/cache'
import { normalizeSettings } from '../projectSettings'
import type { ProjectRules } from '../projectSettings'
import { ProjectRulesForm } from './ProjectRulesForm'
import { setCompanyCache } from './company'
import type { AdminSettings } from './types'
import { useAdminSettings } from './useAdminSettings'
import { useSession } from './session'

const PLACEHOLDERS = ['{name}', '{inviter}', '{company}', '{link}', '{days}']
const SAMPLE = { name: 'Alex', inviter: 'Sam', company: 'Your Company', link: 'https://example.com/invite/...', days: '7' }
const preview = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: keyof typeof SAMPLE) => SAMPLE[k] ?? m)

/** Rules a new project starts with (a copy; existing projects are not touched). */
const rulesOf = (raw: unknown): ProjectRules => {
  const s = normalizeSettings(raw)
  return { statuses: s.statuses, required: s.required, tag_prefixes: s.tag_prefixes, tag_format: s.tag_format, tag_fill_gaps: s.tag_fill_gaps, report: { sections: s.report.sections }, photo_quality: s.photo_quality, cable_via_drop: s.cable_via_drop }
}

/** Company profile and branding, plus what new projects and invitations start with. One form, one Save bar. */
export function CompanyTab() {
  const { settings, setSettings, error, save } = useAdminSettings()
  const session = useSession()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [logoVersion, setLogoVersion] = useState(0)
  const file = useRef<HTMLInputElement>(null)
  const [sets, setSets] = useState<SymbolSet[]>([])
  useEffect(() => { loadSymbolSets().then(r => setSets([...r.data].sort((a, b) => a.sort - b.sort))).catch(() => {}) }, [])
  const logoUrl = useAuthedUrl(settings?.company.has_logo ? companyLogoUrl(logoVersion) : undefined)
  if (!settings) return <p className="muted">{error || 'Loading…'}</p>
  const s = settings

  const patch = (p: Partial<AdminSettings['company']>) => setSettings({ ...s, company: { ...s.company, ...p } })
  const patchInvite = (p: Partial<AdminSettings['invite']>) => { setSettings({ ...s, invite: { ...s.invite, ...p } }); setMsg('') }
  const defaults = rulesOf(s.project_defaults)

  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(''); setErr('')
    try {
      await save({
        company: { name: s.company.name, address: s.company.address, phone: s.company.phone, prepared_by: s.company.prepared_by },
        tags: { padding: s.tags.padding },
        photos: { max_dimension: s.photos.max_dimension },
        invite: s.invite,
        project_defaults: s.project_defaults,
      })
      setMsg('Saved')
      void session?.refreshCompanies() // the header switcher shows the new company name
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
    <form className="stack company-profile" onSubmit={submit}>
      <h3 className="group-title">Branding and details</h3>
      <p className="muted small -mt">Shown on the as-built report and in emails. These settings are for this company only.</p>
      <div className="tidy-grid">
      <section className="card settings-card">
        <h3><Icon name="building" size={18} /> Company</h3>
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
        <h3><Icon name="file" size={18} /> Report defaults</h3>
        <p className="muted small">Filled into the as-built report title page. People can still change them for each report.</p>
        <label className="field">Prepared by<input value={s.company.prepared_by} onChange={e => patch({ prepared_by: e.target.value })} placeholder="e.g. Field Services Team" /></label>
        <p className="muted small">The report also uses the company name and address above.</p>
      </section>

      <section className="card settings-card">
        <h3><Icon name="tag" size={18} /> Tags</h3>
        <label className="field">Tag number digits
          <select value={s.tags.padding} onChange={e => setSettings({ ...s, tags: { padding: Number(e.target.value) as 2 | 3 | 4 } })}>
            <option value={2}>2 digits (CAM-01)</option>
            <option value={3}>3 digits (CAM-001)</option>
            <option value={4}>4 digits (CAM-0001)</option>
          </select>
        </label>
        <p className="muted small">Applies to tags created from now on; existing tags are not renamed. Each project can override the format, numbering and prefixes in its Settings tab.</p>
      </section>

      <section className="card settings-card">
        <h3><Icon name="camera" size={18} /> Photos</h3>
        <label className="field">Longest side (pixels)
          <input type="number" min={800} max={6000} step={100} value={s.photos.max_dimension}
            onChange={e => setSettings({ ...s, photos: { max_dimension: Number(e.target.value) } })} />
        </label>
        <p className="muted small">Photos are shrunk to this size on the phone before uploading. 2000 is a good balance.</p>
      </section>

      </div>

      <h3 className="group-title">Invitations</h3>
      <div className="tidy-grid">
        <section className="card settings-card">
          <h3><Icon name="mail" size={18} /> Invite email</h3>
          <label className="field">Sender name in the text
            <input value={s.invite.sender_name} placeholder="Blank = the name of the person who invites" onChange={e => patchInvite({ sender_name: e.target.value })} />
          </label>
          <label className="field">Subject
            <input value={s.invite.subject} onChange={e => patchInvite({ subject: e.target.value })} />
          </label>
          <label className="field">Message
            <textarea rows={8} value={s.invite.body} onChange={e => patchInvite({ body: e.target.value })} />
          </label>
          <p className="muted small">Placeholders: {PLACEHOLDERS.join(' ')}. The message must include {'{link}'}. Needs the email settings (Email section) to send; otherwise you copy the link.</p>
          <details>
            <summary className="small">Preview</summary>
            <div className="small"><strong>{preview(s.invite.subject)}</strong></div>
            <pre className="small invite-preview">{preview(s.invite.body)}</pre>
          </details>
        </section>
      </div>

      <h3 className="group-title">Defaults for new projects</h3>
      <p className="muted small -mt">New projects start with a copy of these. Changing them later does not touch projects that already exist.</p>
      <ProjectRulesForm value={defaults} sets={sets}
        onChange={r => { setSettings({ ...s, project_defaults: r }); setMsg('') }} />

      <div className="save-bar">
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row"><button className="primary">Save changes</button>{msg && <span className="muted small" role="status">{msg}</span>}</div>
      </div>
    </form>
  )
}
