import { useSyncStatus } from './hooks'

/** Thin banner shown while offline. `children` adds context (e.g. "this plan isn't cached"). */
export function OfflineBanner({ children, always }: { children?: React.ReactNode; always?: boolean }) {
  const { online } = useSyncStatus()
  if (online && !always) return null
  return <div className="offline-banner" role="status">{children ?? 'You are offline. Showing data saved on this device.'}</div>
}
