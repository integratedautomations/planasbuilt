import type { BoxGeometry, Markup } from './types'
import { deviceCenter } from './geometry'
import { deviceRadius } from './stacks'
import type { StackIndex } from './stacks'

/** What to do when a device is placed on top of a device of another type. */
export type ReplaceChoice = 'ask' | 'replace' | 'both'
export const isReplaceChoice = (v: unknown): v is ReplaceChoice => v === 'ask' || v === 'replace' || v === 'both'

/**
 * Nearest existing device within `factor` x its radius of the point that is NOT of the same set and type
 * (the same-type case snaps into a stack instead, see findSnapTarget).
 */
export function findOverlapTarget(markups: Iterable<Markup>, p: { x: number; y: number }, setId: string | null | undefined, typeId: string | null, factor = 1.2): Markup | null {
  if (!setId) return null
  let best: Markup | null = null, bestD = Infinity
  for (const m of markups) {
    if (m.type !== 'device' || !('width' in m.geometry)) continue
    if (m.symbol_set_id === setId && (m.device_type_id ?? null) === typeId) continue
    const g = m.geometry as BoxGeometry
    const c = deviceCenter(g)
    const d = Math.hypot(c.x - p.x, c.y - p.y)
    if (d <= factor * deviceRadius(g) && d < bestD) { best = m; bestD = d }
  }
  return best
}

/** What happens next: no target = just place; otherwise follow the saved choice, or ask. */
export function decideOverlap(choice: ReplaceChoice, hasTarget: boolean): 'place' | 'ask' | 'replace' | 'both' {
  if (!hasTarget) return 'place'
  return choice === 'ask' ? 'ask' : choice
}

/** The devices a replace acts on: every member of the stack the target belongs to, else just the target. */
export function replaceTargets(target: Markup, stacks: StackIndex): Markup[] {
  return stacks.byId.get(target.id)?.members ?? [target]
}

/** "Replace FA-3 (Smoke detector) with Camera?" text for the prompt. */
export function replacePrompt(targets: Markup[], oldTypeName: string, newTypeName: string): string {
  const what = targets.length === 1
    ? [targets[0].tag, oldTypeName].filter(Boolean).join(' ') || 'device'
    : `${targets.length} ${oldTypeName || 'devices'}`
  return `Replace ${what} with ${newTypeName || 'new device'}?`
}
