import { fetchAll } from '../devices/loadDevices'
import type { Markup } from '../markups/types'
import { isOfflineError } from '../offline/classify'
import { cacheAllowed } from '../offline/cacheOwner'
import { db } from '../offline/db'
import { pendingMarkupIds } from '../offline/sync'

/**
 * The devices and cable runs of a project. Online: the server's answer (already limited to what this person may see), with rows that
 * still have unsent local edits taken from this device. Offline: the plans saved on this device.
 */
export async function loadProjectWiring(projectId: string, docIds: string[]): Promise<{ markups: Markup[]; fromCache: boolean }> {
  try {
    const rows = [...await fetchAll(projectId, 'device'), ...await fetchAll(projectId, 'cable')]
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
      if (!(await db.kv.get(`cache:${d}`))) continue
      out.push(...(await db.markups.where('document_id').equals(d).toArray()).filter(m => !(m as { deleted?: boolean }).deleted && (m.type === 'device' || m.type === 'cable')))
    }
    if (!out.length) throw new Error('You are offline and the plans of this project are not saved on this device.')
    return { markups: out, fromCache: true }
  }
}
