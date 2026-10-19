import { applyRemoteMarkup, applyRemoteMarkupDelete } from '../offline/sync'
import type { Markup } from '../markups/types'

export interface ApplyDeps {
  applyMarkup: (row: Markup) => Promise<boolean>
  applyDelete: (docId: string, id: string) => Promise<boolean>
}
const defaultDeps: ApplyDeps = { applyMarkup: applyRemoteMarkup, applyDelete: applyRemoteMarkupDelete }

/**
 * Write a server data message into the local store. Returns true when a markup row was actually changed
 * (false when it was skipped because this device has unsent edits for it, or the message is not a markup one).
 * `docId` is the document we are in; a message for another document is ignored.
 */
export async function applyServerMessage(msg: any, docId: string | null, deps: ApplyDeps = defaultDeps): Promise<boolean> {
  if (!msg || msg.type !== 'markup' || !docId) return false
  if (msg.op === 'upsert' && msg.markup && typeof msg.markup.id === 'string') {
    if (msg.markup.document_id && msg.markup.document_id !== docId) return false
    return deps.applyMarkup(msg.markup as Markup)
  }
  if (msg.op === 'delete' && typeof msg.id === 'string') return deps.applyDelete(docId, msg.id)
  return false
}

/** Text for the toast when someone else deletes the markup we have selected, e.g. "Dana deleted CAM-04". */
export function deletedToast(by: string | undefined, tag: string | undefined, type: string | undefined) {
  return `${by || 'Someone'} deleted ${tag || type || 'a markup'}`
}
