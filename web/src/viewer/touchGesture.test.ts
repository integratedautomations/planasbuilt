import { describe, expect, it } from 'vitest'
import { createTouchArbiter, isDoubleTap } from './touchGesture'
import type { GestureAction } from './touchGesture'

/** Drives the arbiter like a tool does: counts what would be committed. */
function harness() {
  const a = createTouchArbiter()
  const log = { placed: 0, pathPoints: 0, panned: 0, cancels: 0 }
  const act = (r: GestureAction, placeTool = true) => {
    if (r === 'tap') { if (placeTool) log.placed++; log.pathPoints++ }
    if (r === 'drag-start') log.panned++
    if (r === 'cancel') log.cancels++
  }
  return { a, log, act }
}

describe('touch arbiter', () => {
  it('a single tap places exactly one', () => {
    const { a, log, act } = harness()
    act(a.down(1, 100, 100)); act(a.move(1, 102, 101)); act(a.up(1))
    expect(log.placed).toBe(1)
  })

  it('a two-finger pinch places nothing', () => {
    const { a, log, act } = harness()
    act(a.down(1, 100, 100)); act(a.down(2, 200, 100))
    act(a.move(1, 80, 100)); act(a.move(2, 220, 100))
    act(a.up(1)); act(a.up(2))
    expect(log.placed).toBe(0)
    expect(log.cancels).toBe(1)
  })

  it('a drag beyond the slop places nothing (it is a pan)', () => {
    const { a, log, act } = harness()
    act(a.down(1, 100, 100)); act(a.move(1, 140, 100)); act(a.up(1))
    expect(log.placed).toBe(0)
    expect(log.panned).toBe(1)
  })

  it('the finger left after a pinch does nothing until every finger lifts', () => {
    const { a, log, act } = harness()
    act(a.down(1, 100, 100)); act(a.down(2, 200, 100)); act(a.up(2))
    expect(a.move(1, 300, 300)).toBe('none')
    act(a.up(1))
    expect(log.placed).toBe(0)
    // a fresh touch afterwards works again
    act(a.down(3, 50, 50)); act(a.up(3))
    expect(log.placed).toBe(1)
  })

  it('a third finger or re-touch during a dead gesture stays ignored', () => {
    const a = createTouchArbiter()
    a.down(1, 0, 0); a.down(2, 5, 5); a.up(2)
    expect(a.down(3, 9, 9)).toBe('ignore')
    expect(a.up(3)).toBe('none')
    expect(a.up(1)).toBe('none')
    expect(a.phase).toBe('idle')
  })

  it('polyline points come only from taps', () => {
    const { a, log, act } = harness()
    act(a.down(1, 10, 10)); act(a.up(1))            // tap -> point
    act(a.down(1, 50, 50)); act(a.move(1, 90, 50)); act(a.up(1)) // drag -> pan
    act(a.down(1, 10, 10)); act(a.down(2, 60, 10)); act(a.up(1)); act(a.up(2)) // pinch
    act(a.down(1, 70, 70)); act(a.up(1))            // tap -> point
    expect(log.pathPoints).toBe(2)
  })

  it('a killed gesture (long press) yields no tap', () => {
    const a = createTouchArbiter()
    a.down(1, 0, 0)
    expect(a.kill()).toBe(true)
    expect(a.up(1)).toBe('none')
  })

  it('pointercancel aborts a live gesture', () => {
    const a = createTouchArbiter()
    a.down(1, 0, 0)
    expect(a.abort(1)).toBe('cancel')
    expect(a.phase).toBe('idle')
  })

  it('detects a double tap', () => {
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 3, y: 2 }, 200, 8)).toBe(true)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 3, y: 2 }, 900, 8)).toBe(false)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 30, y: 2 }, 100, 8)).toBe(false)
    expect(isDoubleTap(null, { x: 0, y: 0 }, 0, 8)).toBe(false)
  })
})
