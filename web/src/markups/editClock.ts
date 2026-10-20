import type { Markup } from './types'

/**
 * Orders local edits against asynchronous remote refreshes: a remote row that was read before a later
 * local edit must not overwrite it (the Dexie read is async, the user's commit is not).
 */
export class EditClock {
  private tick = 0
  private edits = new Map<string, number>()
  /** Mark `ids` as edited locally now. */
  edit(ids: Iterable<string>) { const t = ++this.tick; for (const id of ids) this.edits.set(id, t) }
  /** Stamp the moment a remote event arrived. */
  stamp() { return ++this.tick }
  /** True when `id` was edited locally after `stamp`. */
  newerThan(id: string, stamp: number) { return (this.edits.get(id) ?? 0) > stamp }
  reset() { this.edits.clear() }
}

/** Fold remote rows (null = deleted) into the map, skipping ids that were edited locally after `stamp`. */
export function applyRemoteRows(
  prev: Map<string, Markup>, ids: string[], rows: (Markup | undefined)[], clock: EditClock, stamp: number,
): Map<string, Markup> {
  const next = new Map(prev)
  ids.forEach((id, i) => {
    if (clock.newerThan(id, stamp)) return
    const r = rows[i]
    if (r) next.set(id, r); else next.delete(id)
  })
  return next
}

/** Tracks the last mergeable commit so quick successive changes with the same key fold into one undo step. */
export class MergeTracker {
  private last: { key: string; at: number } | null = null
  private windowMs: number
  constructor(windowMs = 1500) { this.windowMs = windowMs }
  /** Does a commit with `key` at `now` fold into the previous undo step? */
  canMerge(key: string | undefined, now: number) { return !!key && !!this.last && this.last.key === key && now - this.last.at < this.windowMs }
  note(key: string | undefined, now: number) { this.last = key ? { key, at: now } : null }
  /** Undo / redo / reload break the chain: the next commit starts a new step. */
  clear() { this.last = null }
}
