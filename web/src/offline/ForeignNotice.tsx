import { useSyncStatus } from './hooks'
import { discardForeign } from './sync'
import { foreignNotice } from './owner'

/** Shared device: another user's unsent changes are parked until they sign in again (or the new user discards them). */
export function ForeignNotice() {
  const { foreign } = useSyncStatus()
  if (!foreign) return null
  return (
    <div className="foreign-notice" role="alert">
      <span>{foreignNotice(foreign)}</span>
      <button className="danger" onClick={() => { if (confirm(`Discard ${foreign.count} unsent change${foreign.count === 1 ? '' : 's'} from ${foreign.name}? This cannot be undone.`)) void discardForeign() }}>Discard</button>
    </div>
  )
}
