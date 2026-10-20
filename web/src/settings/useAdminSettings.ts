import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { loadCompany } from './company'
import type { AdminSettings } from './types'

/** Loads the admin settings and saves one or more sections; the server returns the (secret-free) result. */
export function useAdminSettings() {
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api<AdminSettings>('/settings').then(setSettings).catch(e => setError(e.message)) }, [])
  const save = useCallback(async (patch: Partial<Record<keyof AdminSettings, unknown>>) => {
    const next = await api<AdminSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) })
    setSettings(next)
    void loadCompany(true)
    return next
  }, [])
  return { settings, setSettings, error, save }
}
