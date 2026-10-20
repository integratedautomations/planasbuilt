// The organization's public settings (name, logo, tag padding, photo size), cached so they work offline.
import { api } from '../api'
import type { CompanyInfo } from '../api'

const KEY = 'planmark.company'
let cache: CompanyInfo | null = null
let inflight: Promise<CompanyInfo | null> | null = null

function readLocal(): CompanyInfo | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') } catch { return null }
}

/** Latest known company info: fetched once per page load, falling back to the last copy saved on this device. */
export function loadCompany(force = false): Promise<CompanyInfo | null> {
  if (cache && !force) return Promise.resolve(cache)
  if (!inflight || force) {
    inflight = api<CompanyInfo>('/company').then(c => {
      setCompanyCache(c)
      return c
    }).catch(() => cache ?? readLocal()).finally(() => { inflight = null })
  }
  return inflight
}
export function setCompanyCache(c: CompanyInfo) {
  cache = c
  try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* storage unavailable */ }
}
