import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { UserAvatar } from '../ui/UserAvatar'
import { useSession } from './session'

export const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?'

/** Avatar button in the header of non-viewer pages: Settings, Users (admins) and Sign out. */
export function UserMenu() {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  if (!session) return null
  const { user, signOut } = session
  return (
    <div className="user-menu" ref={ref}>
      <button className="avatar-btn" aria-haspopup="menu" aria-expanded={open} title={user.name} onClick={() => setOpen(o => !o)}>
        <UserAvatar userId={user.id} name={user.name} avatar={user.avatar} bare />
      </button>
      {open && (
        <div className="user-menu-pop" role="menu" onClick={() => setOpen(false)}>
          <div className="user-menu-who"><strong>{user.name}</strong><span className="muted small">{user.email}</span></div>
          <Link role="menuitem" to="/preferences">Preferences</Link>
          <Link role="menuitem" to="/settings">Settings</Link>
          {user.is_admin && <Link role="menuitem" to="/users">Company members</Link>}
          {user.platform_admin && <Link role="menuitem" to="/companies">Companies</Link>}
          {user.is_admin && <Link role="menuitem" to="/backups">Backups</Link>}
          <button role="menuitem" onClick={signOut}>Sign out</button>
        </div>
      )}
    </div>
  )
}
