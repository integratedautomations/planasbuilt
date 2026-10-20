import { UserAvatar } from '../ui/UserAvatar'
import { avatarStack } from './presence'
import type { Peer } from './presence'

/** Who is in this document: up to `max` coloured initials, then "+N". Tapping one jumps to that person. */
export function Avatars({ peers, max, onJump }: { peers: Peer[]; max: number; onJump: (p: Peer) => void }) {
  if (!peers.length) return null
  const { shown, more } = avatarStack(peers, max)
  return (
    <span className="avatars" aria-label={`${peers.length} other ${peers.length === 1 ? 'person' : 'people'} here`}>
      {shown.map(p => (
        <button key={p.userId} type="button" className="avatar" style={{ background: p.color }}
          title={p.name} aria-label={`Go to ${p.name}`} onClick={() => onJump(p)}>
          <UserAvatar userId={p.userId} name={p.name} avatar={p.avatar} bare />
        </button>
      ))}
      {more > 0 && <span className="avatar-more">+{more}</span>}
    </span>
  )
}
