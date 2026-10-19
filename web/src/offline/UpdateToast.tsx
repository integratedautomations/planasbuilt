import { useRegisterSW } from 'virtual:pwa-register/react'

/** Registers the service worker; shows a toast when a new version is waiting. */
export function UpdateToast() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisterError: e => console.warn('service worker registration failed', e),
  })
  if (!needRefresh) return null
  return (
    <div className="update-toast" role="alert">
      <span>Update available</span>
      <button className="primary" onClick={() => updateServiceWorker(true)}>Reload</button>
    </div>
  )
}
