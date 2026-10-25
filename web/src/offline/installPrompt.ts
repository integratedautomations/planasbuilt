/** "Add to Home Screen" nudge: iOS evicts site data after about a week unless the app is installed. */
import { useEffect, useState } from 'react'

const DISMISS_KEY = 'planmark.installDismissed'
export const DISMISS_MS = 7 * 24 * 3600 * 1000

export interface Env { userAgent: string; platform?: string; maxTouchPoints?: number; standalone: boolean }

/** iPhone, iPad, and iPadOS (which reports as a Mac with touch). Covers Safari and other iOS browsers. */
export function isIos(e: Pick<Env, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  if (/iPad|iPhone|iPod/.test(e.userAgent)) return true
  return e.platform === 'MacIntel' && (e.maxTouchPoints ?? 0) > 1
}

/** iOS in an ordinary browser tab (not the installed Home Screen app). */
export const isIosTab = (e: Env) => isIos(e) && !e.standalone

export function readEnv(): Env {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { standalone?: boolean }
  let standalone = nav.standalone === true
  try { if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) standalone = true } catch { /* none */ }
  return { userAgent: nav.userAgent ?? '', platform: nav.platform, maxTouchPoints: nav.maxTouchPoints, standalone }
}

function safeStore(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

export function isDismissed(now: number, store: Pick<Storage, 'getItem'> | null = safeStore()): boolean {
  try {
    const t = Number(store?.getItem(DISMISS_KEY))
    return Number.isFinite(t) && t > 0 && now - t < DISMISS_MS
  } catch { return false }
}

export function dismiss(now = Date.now(), store: Pick<Storage, 'setItem'> | null = safeStore()) {
  try { store?.setItem(DISMISS_KEY, String(now)) } catch { /* private mode */ }
}

export type InstallKind = 'ios' | 'chromium' | null

/**
 * What to show. `relevant` = there is unsent work or the user just made a project available offline.
 * iOS tab -> steps; Chromium with a captured beforeinstallprompt -> Install button.
 */
export function installBannerKind(o: { env: Env; relevant: boolean; dismissed: boolean; hasPrompt: boolean }): InstallKind {
  if (!o.relevant || o.dismissed || o.env.standalone) return null
  if (isIosTab(o.env)) return 'ios'
  if (o.hasPrompt) return 'chromium'
  return null
}

interface BipEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: BipEvent | null = null
const subs = new Set<() => void>()
const notify = () => { for (const s of [...subs]) s() }

export function captureInstallPrompt() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as BipEvent; notify() })
  window.addEventListener('appinstalled', () => { deferred = null; notify() })
}
export const hasInstallPrompt = () => deferred !== null
export async function runInstallPrompt() {
  const e = deferred
  if (!e) return
  deferred = null; notify()
  try { await e.prompt(); await e.userChoice } catch { /* ignored */ }
}

/** Set by the "make available offline" action so the banner can appear even with nothing unsent. */
let offlineMade = false
export function noteMadeOffline() { offlineMade = true; notify() }

export function useInstallPrompt(unsent: boolean) {
  const [, tick] = useState(0)
  const [gone, setGone] = useState(false)
  useEffect(() => { const f = () => tick(n => n + 1); subs.add(f); return () => { subs.delete(f) } }, [])
  const kind = installBannerKind({ env: readEnv(), relevant: unsent || offlineMade, dismissed: gone || isDismissed(Date.now()), hasPrompt: hasInstallPrompt() })
  return { kind, dismiss: () => { dismiss(); setGone(true) }, install: runInstallPrompt }
}
