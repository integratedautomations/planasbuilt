/** Warn before closing the tab while unsent work exists. The listener exists only while there is something to lose. */
let installed = false
export const leaveHandler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>

export function setLeaveGuard(active: boolean, target: Target | undefined = typeof window === 'undefined' ? undefined : window) {
  if (!target) return
  if (active && !installed) { target.addEventListener('beforeunload', leaveHandler as EventListener); installed = true }
  else if (!active && installed) { target.removeEventListener('beforeunload', leaveHandler as EventListener); installed = false }
}
export const leaveGuardActive = () => installed
