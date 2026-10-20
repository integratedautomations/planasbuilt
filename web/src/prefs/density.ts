// UI density: 'auto' follows the pointer (touch -> comfortable, mouse -> compact); the user can force either.

export type DensityPref = 'auto' | 'compact' | 'comfortable'
export type Density = 'compact' | 'comfortable'
export const DENSITY_PREFS: DensityPref[] = ['auto', 'compact', 'comfortable']

export const isDensityPref = (v: unknown): v is DensityPref => v === 'auto' || v === 'compact' || v === 'comfortable'

/** The density to apply: the override, or by pointer type when 'auto' (a coarse pointer means touch). */
export function resolveDensity(pref: DensityPref | undefined, coarsePointer: boolean): Density {
  if (pref === 'compact' || pref === 'comfortable') return pref
  return coarsePointer ? 'comfortable' : 'compact'
}

/** Sets data-density on the app root (the document element) for the current pointer. */
export function applyDensity(pref: DensityPref | undefined) {
  if (typeof document === 'undefined') return
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
  document.documentElement.setAttribute('data-density', resolveDensity(pref, coarse))
}
