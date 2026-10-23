// The active company's public settings (name, logo, tag padding, photo size), cached so they work offline.
// Cached per company: switching company never shows another company's name or logo.
import { api } from '../api'
import type { CompanyInfo } from '../api'
import { getActiveCompanyId } from '../company/activeCompany'

const KEY = 'planmark.company'
const keyFor = (id: string | null) => `${KEY}.${id ?? 'none'}`
const cache = new Map<string, CompanyInfo>()
let inflight: { id: string; p: Promise<CompanyInfo | null> } | null = null

function readLocal(id: string | null): CompanyInfo | null {
  try { return JSON.parse(localStorage.getItem(keyFor(id)) ?? 'null') } catch { return null }
}

/** Latest known info for the active company: fetched once per page load, falling back to the last copy saved on this device. */
export function loadCompany(force = false): Promise<CompanyInfo | null> {
  const id = getActiveCompanyId()
  const key = keyFor(id)
  const hit = cache.get(key)
  if (hit && !force) return Promise.resolve(hit)
  if (!inflight || inflight.id !== key || force) {
    const p = api<CompanyInfo>('/company').then(c => {
      cache.set(key, c)
      try { localStorage.setItem(key, JSON.stringify(c)) } catch { /* storage unavailable */ }
      return c
    }).catch(() => cache.get(key) ?? readLocal(id)).finally(() => { if (inflight?.p === p) inflight = null })
    inflight = { id: key, p }
  }
  return inflight.p
}
export function setCompanyCache(c: CompanyInfo) {
  const key = keyFor(getActiveCompanyId())
  cache.set(key, c)
  try { localStorage.setItem(key, JSON.stringify(c)) } catch { /* storage unavailable */ }
}
