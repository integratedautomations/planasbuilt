import { useCallback, useEffect, useRef, useState } from 'react'
import { loadMarkups } from '../offline/cache'
import { db } from '../offline/db'
import { on as onSocket } from '../realtime/socket'
import { flushWrites, queueMarkupDelete, queueMarkupPut, subscribe } from '../offline/sync'
import { applyRemoteRows, EditClock, MergeTracker } from './editClock'
import type { Markup } from './types'

/** One undoable step: each entry swaps a markup from `before` to `after` (null = absent). */
export type Change = { before: Markup | null; after: Markup | null }[]

const HISTORY_LIMIT = 200

/**
 * Markups for one document with undo/redo of this user's own edits.
 * Every change is applied locally first, then written to Dexie + the sync outbox (offline/sync.ts),
 * which saves it to the server whenever the network allows. Server answers (tag, version, who/when)
 * come back as 'markup-adopted' events.
 */
export function useMarkups(documentId: string) {
  const [markups, setMarkups] = useState<Map<string, Markup>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [fromCache, setFromCache] = useState(false)
  const undoStack = useRef<Change[]>([])
  const redoStack = useRef<Change[]>([])
  /** Markups someone else changed since this user last touched them (undoing over them is last-write-wins). */
  const remoteTouched = useRef(new Set<string>())
  const [, bump] = useState(0) // re-render so canUndo/canRedo update
  const clock = useRef(new EditClock())
  const lastMerge = useRef(new MergeTracker())

  useEffect(() => {
    let cancelled = false
    setLoaded(false); setLoadError(''); setMarkups(new Map()); setFromCache(false)
    undoStack.current = []; redoStack.current = []; lastMerge.current.clear()
    remoteTouched.current.clear(); clock.current.reset()
    loadMarkups(documentId).then(({ data, fromCache }) => {
      if (cancelled) return
      setMarkups(new Map(data.map(m => [m.id, m])))
      setFromCache(fromCache)
      undoStack.current = []
      redoStack.current = []
      setLoaded(true)
    }).catch(e => { if (!cancelled) setLoadError(e.message) })
    return () => { cancelled = true }
  }, [documentId])

  /** The server numbers new devices (CAM-07); copy the tag into local state and history. */
  const adoptTag = useCallback((id: string, tag: string) => {
    const fix = (m: Markup | null) => (m && m.id === id && !m.tag ? { ...m, tag } : m)
    for (const stack of [undoStack.current, redoStack.current])
      stack.forEach((change, i) => { stack[i] = change.map(c => ({ before: fix(c.before), after: fix(c.after) })) })
    setMarkups(prev => {
      const m = prev.get(id)
      if (!m || m.tag) return prev
      return new Map(prev).set(id, { ...m, tag })
    })
  }, [])

  /** Local-first write: Dexie + outbox. The sync worker does the network part. */
  const persist = useCallback((change: Change) => {
    clock.current.edit(change.map(c => (c.after ?? c.before)!.id))
    for (const { before, after } of change) {
      // A put with nothing before it creates the markup, or brings back one that was deleted (undo of a delete):
      // that is an explicit restore, so the server does not refuse it as an edit of a deleted markup.
      if (after) void queueMarkupPut(documentId, after, before === null ? { restore: true } : {})
      else void queueMarkupDelete(documentId, before!.id)
    }
  }, [documentId])

  // Server answers for this document's markups and remote (live-sync) changes.
  useEffect(() => subscribe(e => {
    if (e.type === 'markup-adopted' && e.docId === documentId) {
      const { id, saved } = e
      if (saved.tag) adoptTag(id, saved.tag)
      // Refresh who/when from the server's answer (history refetches when version changes)
      setMarkups(prev => {
        const m = prev.get(id)
        if (!m || saved.version === undefined) return prev
        const { version, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at } = saved
        return new Map(prev).set(id, { ...m, version, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at })
      })
    } else if (e.type === 'remote-markups' && e.docId === documentId) {
      e.ids.forEach(id => remoteTouched.current.add(id))
      const stamp = clock.current.stamp()
      void db.markups.bulkGet(e.ids).then(rows => setMarkups(prev => applyRemoteRows(prev, e.ids, rows, clock.current, stamp)))
    }
  }), [documentId, adoptTag])

  // After a reconnect the socket has merged the server's list into Dexie: show it (once our own writes landed).
  useEffect(() => onSocket('resync', msg => {
    if (msg.documentId !== documentId) return
    void flushWrites().then(() => db.markups.where('document_id').equals(documentId).toArray()).then(rows => {
      setMarkups(prev => {
        const next = new Map(rows.map(r => [r.id, r]))
        for (const id of next.keys()) { const old = prev.get(id); if (old && old.version !== next.get(id)!.version) remoteTouched.current.add(id) }
        return next
      })
    })
  }), [documentId])

  /** Own undo/redo over a markup someone else changed meanwhile: last write wins, but say so. */
  const warnIfOverwritingRemote = useCallback((change: Change) => {
    for (const c of change) {
      const id = (c.after ?? c.before)!.id
      if (remoteTouched.current.delete(id))
        console.warn(`[live sync] undo/redo overwrites a newer change by someone else to markup ${id} (last write wins)`)
    }
  }, [])

  const applyLocal = useCallback((change: Change, direction: 'forward' | 'back') => {
    setMarkups(prev => {
      const next = new Map(prev)
      for (const c of change) {
        const target = direction === 'forward' ? c.after : c.before
        const id = (c.after ?? c.before)!.id
        if (target) next.set(id, target)
        else next.delete(id)
      }
      return next
    })
  }, [])

  /**
   * Apply and save a change. Changes sharing a `mergeKey` within 1.5s fold into one undo
   * step, so dragging a color or width slider undoes in one go.
   */
  const commit = useCallback((change: Change, mergeKey?: string) => {
    if (!change.length) return
    applyLocal(change, 'forward')
    persist(change)
    for (const c of change) remoteTouched.current.delete((c.after ?? c.before)!.id)
    const now = Date.now()
    const top = undoStack.current[undoStack.current.length - 1]
    if (top && lastMerge.current.canMerge(mergeKey, now)) {
      undoStack.current[undoStack.current.length - 1] = top.map(c => {
        const id = (c.after ?? c.before)!.id
        const latest = change.find(n => (n.after ?? n.before)!.id === id)
        return latest ? { before: c.before, after: latest.after } : c
      })
      lastMerge.current.note(mergeKey, now)
      redoStack.current = []
      return
    }
    lastMerge.current.note(mergeKey, now)
    undoStack.current.push(change)
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
    redoStack.current = []
    bump(n => n + 1)
  }, [applyLocal, persist])

  const undo = useCallback(() => {
    const change = undoStack.current.pop()
    if (!change) return null
    lastMerge.current.clear()
    warnIfOverwritingRemote(change)
    applyLocal(change, 'back')
    persist(change.map(c => ({ before: c.after, after: c.before })))
    redoStack.current.push(change)
    bump(n => n + 1)
    return change
  }, [applyLocal, persist, warnIfOverwritingRemote])

  const redo = useCallback(() => {
    const change = redoStack.current.pop()
    if (!change) return null
    lastMerge.current.clear()
    warnIfOverwritingRemote(change)
    applyLocal(change, 'forward')
    persist(change)
    undoStack.current.push(change)
    bump(n => n + 1)
    return change
  }, [applyLocal, persist, warnIfOverwritingRemote])

  /** Re-reads the document's markups from the server (after page edits moved them) and forgets undo history. */
  const reload = useCallback(async () => {
    const { data, fromCache } = await loadMarkups(documentId)
    setMarkups(new Map(data.map(m => [m.id, m])))
    setFromCache(fromCache)
    undoStack.current = []
    redoStack.current = []
    lastMerge.current.clear()
    bump(n => n + 1)
  }, [documentId])

  return {
    markups, loaded, loadError, fromCache, reload,
    commit, undo, redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  }
}
