import { useEffect, useState } from 'react'
import { useSyncStatus } from './hooks'
import { db } from './db'
import { useInstallPrompt } from './installPrompt'
import { isStale, staleMessage } from './unsent'

/** Top-of-page banners: unsent work older than a day, and the Home Screen / install nudge. */
export function DataSafetyBanner() {
  const s = useSyncStatus()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t) }, [])
  const unsent = s.pending + s.failed
  const install = useInstallPrompt(unsent > 0)
  return (
    <>
      {unsent > 0 && s.oldestAt !== null && isStale(s.oldestAt, now) && (
        <div className="data-safety stale" role="alert"><span>{staleMessage(unsent, s.oldestAt)}</span></div>
      )}
      {install.kind === 'ios' && (
        <div className="data-safety" role="note">
          <div>
            <strong>Add PlanAsBuilt to your Home Screen so iOS doesn't delete your offline data after about a week.</strong>
            <ol>
              <li>Tap the Share button in Safari.</li>
              <li>Choose Add to Home Screen.</li>
              <li>Open PlanAsBuilt from the new icon.</li>
            </ol>
          </div>
          <button onClick={install.dismiss}>Dismiss</button>
        </div>
      )}
      {install.kind === 'chromium' && (
        <div className="data-safety" role="note">
          <span>Install PlanAsBuilt so your offline data is kept safe on this device.</span>
          <span className="row"><button className="primary" onClick={() => void install.install()}>Install</button><button onClick={install.dismiss}>Not now</button></span>
        </div>
      )}
    </>
  )
}

/** Signed out (or session expired) while the outbox still holds work: tell the user, never purge. */
export function SignInRecoveryNotice() {
  const [count, setCount] = useState(0)
  useEffect(() => { void db.outbox.count().then(setCount).catch(() => {}) }, [])
  if (count === 0) return null
  return (
    <div className="data-safety" role="alert">
      <span>Sign in to send {count} unsent change{count === 1 ? '' : 's'}. They are kept on this device.</span>
    </div>
  )
}
