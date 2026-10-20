/** Pure multi-select logic shared by list panels (pages, areas, markups). */
export interface ListSel<T> { selected: T[]; anchor: T | null }
export interface ClickMods { ctrl?: boolean; meta?: boolean; shift?: boolean }

export const emptySel = <T>(): ListSel<T> => ({ selected: [], anchor: null })

/**
 * Next selection after clicking `id` in `order`.
 * Ctrl/Cmd toggles, Shift selects the range from the anchor (replacing the selection, or adding with Ctrl), plain click selects only `id`.
 */
export function clickSelect<T>(order: T[], sel: ListSel<T>, id: T, mods: ClickMods = {}): ListSel<T> {
  const toggle = !!(mods.ctrl || mods.meta)
  if (mods.shift && sel.anchor !== null) {
    const a = order.indexOf(sel.anchor), b = order.indexOf(id)
    if (a >= 0 && b >= 0) {
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
      const base = toggle ? sel.selected.filter(x => !range.includes(x)) : []
      return { selected: [...base, ...range], anchor: sel.anchor }
    }
  }
  if (toggle) {
    return sel.selected.includes(id)
      ? { selected: sel.selected.filter(x => x !== id), anchor: id }
      : { selected: [...sel.selected, id], anchor: id }
  }
  return { selected: [id], anchor: id }
}

export const selectAll = <T>(order: T[]): ListSel<T> => ({ selected: [...order], anchor: order[0] ?? null })

/** Handles Ctrl/Cmd+A and Escape; returns the new selection, or null when the key is not ours. */
export function keySelect<T>(order: T[], sel: ListSel<T>, e: { key: string; ctrlKey?: boolean; metaKey?: boolean }): ListSel<T> | null {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') return selectAll(order)
  if (e.key === 'Escape' && sel.selected.length) return emptySel<T>()
  return null
}

/** Keeps only ids still present in `order`. */
export const pruneSel = <T>(order: T[], sel: ListSel<T>): ListSel<T> => {
  const s = sel.selected.filter(x => order.includes(x))
  return s.length === sel.selected.length ? sel : { selected: s, anchor: sel.anchor !== null && order.includes(sel.anchor) ? sel.anchor : null }
}

/** Drops any browser text selection (a Shift+click range leaves page text highlighted). */
export const clearTextSelection = () => { try { window.getSelection()?.removeAllRanges() } catch { /* ignore */ } }

/**
 * onMouseDown for a list row: with Shift/Ctrl/Cmd held, stops the browser extending a text selection across rows.
 * Inputs, selects and textareas inside the row keep their normal behavior so editing still works.
 */
export function guardRangeMouseDown(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; target: EventTarget; preventDefault: () => void }) {
  if (!(e.shiftKey || e.ctrlKey || e.metaKey)) return
  if ((e.target as HTMLElement).closest?.('input,select,textarea,option')) return
  e.preventDefault()
}
