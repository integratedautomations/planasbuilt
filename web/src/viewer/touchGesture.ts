/**
 * Touch gesture arbitration (pure, no DOM).
 *
 * A touch must never commit a tool action on pointerdown: the first finger of a pinch looks exactly
 * like the start of a tap. The arbiter tracks the live pointers of one gesture and says what each
 * event means:
 *   - one finger, barely moved, lifted        -> 'tap'
 *   - one finger moved past the slop          -> 'drag-start', then 'drag', then 'drag-end'
 *   - a second finger at any time             -> 'cancel' once; the gesture is dead until ALL fingers lift
 * Mouse and pen do not go through the arbiter (they keep acting on pointerdown).
 */
export const TAP_SLOP_PX = 10
export const LONG_PRESS_MS = 500
export const DOUBLE_TAP_MS = 350

export type GestureAction = 'start' | 'cancel' | 'ignore' | 'none' | 'drag-start' | 'drag' | 'tap' | 'drag-end'
type Phase = 'idle' | 'pending' | 'dragging' | 'dead'

export interface TouchArbiter {
  down(id: number, x: number, y: number): GestureAction
  move(id: number, x: number, y: number): GestureAction
  up(id: number): GestureAction
  /** pointercancel: the browser took the touch (scroll, system gesture). */
  abort(id: number): GestureAction
  /** Something else claimed the gesture (long-press menu): nothing more comes of it. Returns true if it was live. */
  kill(): boolean
  readonly phase: Phase
  /** Where the live single finger went down. */
  readonly origin: { x: number; y: number } | null
  readonly count: number
}

export function createTouchArbiter(slop = TAP_SLOP_PX): TouchArbiter {
  let phase: Phase = 'idle'
  const pts = new Map<number, { x: number; y: number }>()
  let origin: { x: number; y: number } | null = null

  const settle = () => { if (pts.size === 0) { phase = 'idle'; origin = null } }

  return {
    down(id, x, y) {
      pts.set(id, { x, y })
      if (phase === 'idle') { phase = 'pending'; origin = { x, y }; return 'start' }
      if (phase === 'dead') return 'ignore'
      phase = 'dead'
      return 'cancel'
    },
    move(id, x, y) {
      if (!pts.has(id)) return 'none'
      pts.set(id, { x, y })
      if (phase === 'dragging') return 'drag'
      if (phase === 'pending' && pts.size === 1 && origin && Math.hypot(x - origin.x, y - origin.y) > slop) {
        phase = 'dragging'
        return 'drag-start'
      }
      return 'none'
    },
    up(id) {
      if (!pts.delete(id)) return 'none'
      let out: GestureAction = 'none'
      if (pts.size === 0) out = phase === 'pending' ? 'tap' : phase === 'dragging' ? 'drag-end' : 'none'
      settle()
      return out
    },
    abort(id) {
      if (!pts.delete(id)) return 'none'
      const wasLive = phase === 'pending' || phase === 'dragging'
      if (pts.size > 0) phase = 'dead'
      settle()
      return wasLive ? 'cancel' : 'none'
    },
    kill() {
      const live = phase === 'pending' || phase === 'dragging'
      if (live) phase = 'dead'
      return live
    },
    get phase() { return phase },
    get origin() { return origin },
    get count() { return pts.size },
  }
}

/** True when a tap at `p` is a second tap on the previous one (finishes a polyline). */
export function isDoubleTap(prev: { x: number; y: number; t: number } | null, p: { x: number; y: number }, t: number, maxDist: number): boolean {
  return !!prev && t - prev.t <= DOUBLE_TAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) <= maxDist
}
