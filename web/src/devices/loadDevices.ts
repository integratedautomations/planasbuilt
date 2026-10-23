import { api } from '../api'
import type { Markup } from '../markups/types'
import { isOfflineError } from '../offline/classify'
import { db } from '../offline/db'
import { cacheAllowed } from '../offline/cacheOwner'
import { pendingMarkupIds } from '../offline/sync'

export const DEVICE_PAGE = 1000

interface Paged { items: Markup[]; next: string | null }

/** Every markup of one type in the project, read page by page from the paged endpoint. */
export async function fetchAll(projectId: string, type: 'device' | 'area' | 'cable'): Promise<Markup[]> {
  const out: Markup[] = []
  let cursor: string | null = null
  do {
    const q: string = `type=${type}&limit=${DEVICE_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page: Paged = await api<Paged>(`/projects/${projectId}/markups?${q}`)
    out.push(...page.items)
    cursor = page.next
  } while (cursor)
  return out
}

const usable = (m: Markup & { deleted?: boolean }) => !m.deleted && (m.type === 'device' || m.type === 'area')

export interface LoadedDevices { markups: Markup[]; fromCache: boolean }

/**
 * The project's devices plus the areas that give them rooms.
 * Online: the server's answer, with the rows that still have unsent local edits taken from this device so they do not flicker back.
 * Offline: whatever this device has saved for the project's plans; throws when nothing is saved.
 */
export async function loadProjectDevices(projectId: string, docIds: string[]): Promise<LoadedDevices> {
  try {
    const [devices, areas] = await Promise.all([fetchAll(projectId, 'device'), fetchAll(projectId, 'area')])
    const rows = [...devices, ...areas]
    const local = new Map<string, Markup>()
    for (const d of docIds) {
      const pending = await pendingMarkupIds(d)
      if (!pending.size) continue
      for (const m of await db.markups.where('document_id').equals(d).toArray()) if (pending.has(m.id)) local.set(m.id, m)
    }
    return { markups: rows.map(m => local.get(m.id) ?? m), fromCache: false }
  } catch (e) {
    if (!isOfflineError(e)) throw e
    if (!(await cacheAllowed())) throw new Error('You are offline and nothing is saved on this device.')
    const out: Markup[] = []
    for (const d of docIds) {
      if (!(await db.kv.get(`cache:${d}`))) continue // only plans that were fully saved; a partial list would mislead
      out.push(...(await db.markups.where('document_id').equals(d).toArray()).filter(usable))
    }
    if (!out.length) throw new Error('You are offline and this project\'s plans are not saved on this device. Open the Plans tab and choose "Make available offline" while online.')
    return { markups: out, fromCache: true }
  }
}
