import type { BoxGeometry, Markup } from './types'
import { deviceCenter } from './geometry'

/** Devices of one set placed on (nearly) the same spot, shown as one icon with a quantity badge. */
export interface Stack {
  /** First member's id; used as a React key. */
  id: string
  /** Members in natural tag order. The last one is drawn as the stack's icon. */
  members: Markup[]
}

export interface StackIndex {
  /** Stacks ordered by their first tag (natural sort). */
  stacks: Stack[]
  byId: Map<string, Stack>
}

export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

const boxOf = (m: Markup) => m.geometry as BoxGeometry
export const deviceRadius = (g: { width: number; height: number }) => Math.min(g.width, g.height) / 2

/** Two devices stack when their centers are within max(2pt, 0.25 x the smaller radius). */
export const stackThreshold = (r1: number, r2: number) => Math.max(2, 0.25 * Math.min(r1, r2))

/** Cluster devices (same page + same symbol set, centers within the threshold) into stacks of 2 or more. */
export function detectStacks(markups: Iterable<Markup>): StackIndex {
  const groups = new Map<string, Markup[]>()
  for (const m of markups) {
    if (m.type !== 'device' || !('width' in m.geometry) || !m.symbol_set_id) continue
    const key = `${m.page}|${m.symbol_set_id}`
    const list = groups.get(key)
    if (list) list.push(m); else groups.set(key, [m])
  }
  const stacks: Stack[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const items = list.map(m => ({ m, c: deviceCenter(boxOf(m)), r: deviceRadius(boxOf(m)) }))
    items.sort((a, b) => a.c.x - b.c.x)
    const parent = items.map((_, i) => i)
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
    const maxBound = Math.max(...items.map(i => stackThreshold(i.r, i.r)))
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length && items[j].c.x - items[i].c.x <= maxBound; j++) {
        const d = Math.hypot(items[j].c.x - items[i].c.x, items[j].c.y - items[i].c.y)
        if (d <= stackThreshold(items[i].r, items[j].r)) parent[find(j)] = find(i)
      }
    }
    const clusters = new Map<number, Markup[]>()
    items.forEach((it, i) => {
      const root = find(i)
      const c = clusters.get(root)
      if (c) c.push(it.m); else clusters.set(root, [it.m])
    })
    for (const members of clusters.values()) {
      if (members.length < 2) continue
      members.sort((a, b) => naturalCompare(a.tag ?? '', b.tag ?? '') || (a.id < b.id ? -1 : 1))
      stacks.push({ id: members[0].id, members })
    }
  }
  stacks.sort((a, b) => naturalCompare(a.members[0].tag ?? '', b.members[0].tag ?? '') || (a.id < b.id ? -1 : 1))
  const byId = new Map<string, Stack>()
  for (const s of stacks) for (const m of s.members) byId.set(m.id, s)
  return { stacks, byId }
}

/** The member drawn as the stack's icon. */
export const stackTop = (s: Stack) => s.members[s.members.length - 1]

/**
 * Nearest existing device of the same set within `factor` x its radius of the point, or null.
 * Used to snap a newly placed device onto a stack.
 */
export function findSnapTarget(markups: Iterable<Markup>, p: { x: number; y: number }, setId: string | null | undefined, factor = 1.2): Markup | null {
  if (!setId) return null
  let best: Markup | null = null, bestD = Infinity
  for (const m of markups) {
    if (m.type !== 'device' || m.symbol_set_id !== setId || !('width' in m.geometry)) continue
    const c = deviceCenter(boxOf(m))
    const d = Math.hypot(c.x - p.x, c.y - p.y)
    if (d <= factor * deviceRadius(boxOf(m)) && d < bestD) { best = m; bestD = d }
  }
  return best
}

const TAG = /^(.*?)(\d+)$/

/** "FA-12–FA-17" for consecutive tags with one prefix, otherwise "FA-12 +5" (first tag plus the rest). */
export function tagRange(tags: string[]): string {
  const sorted = tags.filter(Boolean).sort(naturalCompare)
  if (!sorted.length) return ''
  if (sorted.length === 1) return sorted[0]
  const parsed = sorted.map(t => TAG.exec(t))
  if (parsed.every(Boolean) && parsed.every(p => p![1] === parsed[0]![1])) {
    const nums = parsed.map(p => +p![2])
    if (nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return `${sorted[0]}–${sorted[sorted.length - 1]}`
  }
  return `${sorted[0]} +${sorted.length - 1}`
}
