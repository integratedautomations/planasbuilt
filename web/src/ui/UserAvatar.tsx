import { useAuthedUrl } from '../useAuthedUrl'
import { contrastText, initials, userColor } from '../realtime/presence'

export const avatarUrl = (userId: string, version: number) => `/api/users/${userId}/avatar?v=${version}`

/**
 * A person's profile picture, or their initials in a stable colour when they have none.
 * `bare` renders only the inner content (for use inside an existing round button).
 */
/** Inline style for an initials avatar with a chosen colour (text auto-contrasts); empty when none is chosen. */
export const initialsStyle = (color?: string | null): React.CSSProperties => (color ? { background: color, color: contrastText(color) } : {})

export function UserAvatar({ userId, name, avatar, color, size, bare }: { userId: string; name: string; avatar?: number | null; color?: string | null; size?: number; bare?: boolean }) {
  const src = useAuthedUrl(avatar != null ? avatarUrl(userId, avatar) : undefined)
  const inner = src
    ? <img src={src} alt="" draggable={false} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
    : <>{initials(name)}</>
  if (bare) return inner
  const px = size ?? 28
  return (
    <span title={name} aria-label={name} style={{
      width: px, height: px, borderRadius: '50%', background: userColor(userId), color: '#fff', ...initialsStyle(color), fontSize: Math.round(px * 0.4),
      fontWeight: 700, display: 'inline-grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0, lineHeight: 1,
    }}>{inner}</span>
  )
}
