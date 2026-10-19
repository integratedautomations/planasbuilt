import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Markup } from './types'

/** One undoable step: each entry swaps a markup from `before` to `after` (null = absent). */
export type Change = { before: Markup | null; after: Markup | null }[]

const HISTORY_LIMIT = 200

/**
 * Markups for one document with undo/redo of this user's own edits.
 * Every change is applied locally first, then saved to the server.
 */
export function useMarkups(documentId: string) {
  const [markups, setMarkups] = useState<Map<string, Markup>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [pending, setPending] = useState(0)
  const undoStack = useRef<Change[]>([])
  const redoStack = useRef<Change[]>([])
  const [, bump] = useState(0) // re-render so canUndo/canRedo update

  useEffect(() => {
    setLoaded(false)
    api<Markup[]>(`/documents/${documentId}/markups`).then(rows => {
      setMarkups(new Map(rows.map(m => [m.id, m])))
      undoStack.current = []
      redoStack.current = []
      setLoaded(true)
    }).catch(e => setSaveError(e.message))
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

  const persist = useCallback((change: Change) => {
    for (const { before, after } of change) {
      const id = (after ?? before)!.id
      setPending(n => n + 1)
      const req = after
        ? api<Markup>(`/documents/${documentId}/markups/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
              page: after.page, type: after.type, geometry: after.geometry,
              style: after.style, text: after.text, layer_id: after.layer_id,
              symbol_set_id: after.symbol_set_id ?? null, tag: after.tag ?? '',
              status: after.status ?? '', fields: after.fields ?? {},
            }),
          }).then(saved => {
            if (saved.tag && saved.tag !== after.tag) adoptTag(id, saved.tag)
            // Refresh who/when from the server's answer (history refetches when version changes)
            setMarkups(prev => {
              const m = prev.get(id)
              if (!m || saved.version === undefined) return prev
              const { version, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at } = saved
              return new Map(prev).set(id, { ...m, version, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at })
            })
          })
        : api(`/documents/${documentId}/markups/${id}`, { method: 'DELETE' })
      req.then(() => setSaveError(''))
        .catch(e => setSaveError(`Not saved: ${e.message}`))
        .finally(() => setPending(n => n - 1))
    }
  }, [documentId, adoptTag])

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

  const lastMerge = useRef<{ key: string; at: number } | null>(null)

  /**
   * Apply and save a change. Changes sharing a `mergeKey` within 1.5s fold into one undo
   * step, so dragging a color or width slider undoes in one go.
   */
  const commit = useCallback((change: Change, mergeKey?: string) => {
    if (!change.length) return
    applyLocal(change, 'forward')
    persist(change)
    const now = Date.now()
    const top = undoStack.current[undoStack.current.length - 1]
    if (mergeKey && top && lastMerge.current?.key === mergeKey && now - lastMerge.current.at < 1500) {
      undoStack.current[undoStack.current.length - 1] = top.map(c => {
        const id = (c.after ?? c.before)!.id
        const latest = change.find(n => (n.after ?? n.before)!.id === id)
        return latest ? { before: c.before, after: latest.after } : c
      })
      lastMerge.current = { key: mergeKey, at: now }
      redoStack.current = []
      return
    }
    lastMerge.current = mergeKey ? { key: mergeKey, at: now } : null
    undoStack.current.push(change)
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
    redoStack.current = []
    bump(n => n + 1)
  }, [applyLocal, persist])

  const undo = useCallback(() => {
    const change = undoStack.current.pop()
    if (!change) return null
    applyLocal(change, 'back')
    persist(change.map(c => ({ before: c.after, after: c.before })))
    redoStack.current.push(change)
    bump(n => n + 1)
    return change
  }, [applyLocal, persist])

  const redo = useCallback(() => {
    const change = redoStack.current.pop()
    if (!change) return null
    applyLocal(change, 'forward')
    persist(change)
    undoStack.current.push(change)
    bump(n => n + 1)
    return change
  }, [applyLocal, persist])

  return {
    markups, loaded, saveError, saving: pending > 0,
    commit, undo, redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  }
}
