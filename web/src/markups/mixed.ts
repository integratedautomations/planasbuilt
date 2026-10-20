import { UNIQUE_FIELD } from './copy'
import type { Markup } from './types'

export interface Common<T> { value: T | undefined; mixed: boolean; count: number }

/** Shared value of `get` across `items` (skipping those where it is `undefined`, i.e. not applicable); mixed when they disagree. */
export function commonValue<I, T>(items: I[], get: (i: I) => T | undefined): Common<T> {
  const vals = items.map(get).filter(v => v !== undefined) as T[]
  if (!vals.length) return { value: undefined, mixed: false, count: 0 }
  const key = (v: T) => JSON.stringify(v)
  const k0 = key(vals[0])
  return { value: vals[0], mixed: vals.some(v => key(v) !== k0), count: vals.length }
}

/** Common value of a custom field; markups without any fields object still count as '' (empty). */
export const commonField = (ms: Markup[], key: string) => commonValue(ms, m => m.fields?.[key] ?? '')

/** True for field keys that identify one physical unit (ip/mac/serial) and so must never be mass-set. */
export const isUniqueFieldKey = (key: string, type?: string) => UNIQUE_FIELD.test(key) || type === 'ip'

/** Applies `patch` to every markup that `applies` to; returns commit-ready changes, skipping no-ops. */
export function batchChanges(ms: Markup[], patch: (m: Markup) => Markup, applies: (m: Markup) => boolean = () => true) {
  return ms.filter(applies).map(m => ({ before: m, after: patch(m) })).filter(c => c.after !== c.before)
}
