import type { Markup } from '../markups/types'
import { parsePageRange } from './pageSubset'

export type PageChoice = 'all' | 'current' | 'custom'

export interface PrintSettings {
  range: PageChoice
  /** For range === 'custom', e.g. "1-3,5". */
  custom: string
  /** Fit to the paper (true) or print at actual size (false). */
  fit: boolean
  includeMarkups: boolean
  /** Layer keys left unchecked: custom layer ids, '' for the default layer, `set:<id>` for symbol sets. */
  hiddenLayers: string[]
}

export const DEFAULT_PRINT: PrintSettings = { range: 'all', custom: '', fit: true, includeMarkups: true, hiddenLayers: [] }

/** Pages a print job covers, or an error for the dialog. */
export function printPages(s: Pick<PrintSettings, 'range' | 'custom'>, current: number, count: number): { pages: number[]; error?: string } {
  if (s.range === 'all') return { pages: Array.from({ length: count }, (_, i) => i + 1) }
  if (s.range === 'current') return { pages: [current] }
  return parsePageRange(s.custom, count)
}

/** Markups left after unchecking layers (same rule as the viewer's hidden layers: own layer, or its symbol set's). */
export function printableMarkups(markups: Iterable<Markup>, hiddenLayers: Iterable<string>): Markup[] {
  const hidden = new Set(hiddenLayers)
  return [...markups].filter(m => !hidden.has(m.layer_id ?? '') && !(m.symbol_set_id && hidden.has(`set:${m.symbol_set_id}`)))
}

