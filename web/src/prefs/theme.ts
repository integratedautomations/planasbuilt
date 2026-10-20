// Color scheme choice: 'auto' follows the device; light / dark force it via data-theme on the root element.
export type ThemePref = 'auto' | 'light' | 'dark'
export const THEME_PREFS: ThemePref[] = ['auto', 'light', 'dark']
export const isThemePref = (v: unknown): v is ThemePref => v === 'auto' || v === 'light' || v === 'dark'

/** Sets (or clears, for 'auto') data-theme on the document element. */
export function applyTheme(pref: ThemePref | undefined) {
  if (typeof document === 'undefined') return
  if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref)
  else document.documentElement.removeAttribute('data-theme')
}
