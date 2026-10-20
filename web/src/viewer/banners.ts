// Viewer status banners collapse into one chip: the most important one is shown, with a count of the rest.

export type BannerKind = 'foreign' | 'failed' | 'authRequired' | 'notCached' | 'offline' | 'viewingOld' | 'busy' | 'orphaned'
export type BannerLevel = 'bad' | 'warn' | 'info'

export interface Banner {
  id: BannerKind
  level: BannerLevel
  text: string
  /** Optional action button in the popover (and the chip's own label when it is the main one). */
  action?: { label: string; run: () => void; danger?: boolean }
}

/** Lower = more important. Data-loss risks first, then connectivity, then context. */
export const BANNER_PRIORITY: Record<BannerKind, number> = {
  foreign: 0, authRequired: 1, failed: 2, notCached: 3, offline: 4, viewingOld: 5, busy: 6, orphaned: 7,
}

/** Banners most important first (stable for equal priority). */
export function orderBanners(list: Banner[]): Banner[] {
  return list.map((b, i) => ({ b, i })).sort((x, y) => BANNER_PRIORITY[x.b.id] - BANNER_PRIORITY[y.b.id] || x.i - y.i).map(x => x.b)
}

/** What the chip shows: the top banner and how many more sit behind it. */
export function chipSummary(list: Banner[]): { top: Banner; more: number; ordered: Banner[] } | null {
  const ordered = orderBanners(list)
  return ordered.length ? { top: ordered[0], more: ordered.length - 1, ordered } : null
}

/** Short chip text for a banner kind (the full sentence lives in the popover). */
export const BANNER_SHORT: Record<BannerKind, string> = {
  foreign: 'Sync paused', authRequired: 'Sign in to sync', failed: 'Sync failed', notCached: 'Not saved offline', offline: 'Offline',
  viewingOld: 'Old revision', busy: 'Working…', orphaned: 'Orphaned markups',
}
