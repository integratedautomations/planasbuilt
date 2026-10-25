import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Link } from 'react-router-dom'
import { UserAvatar } from '../ui/UserAvatar'
import { useSession } from './session'
import { pendingInvitations } from '../company/switcher'

export const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?'

/** Avatar button in the header of non-viewer pages: Account, Company admin, Platform, Catalog (read-only for non-admins) and Sign out. */
export function UserMenu() {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [inviteErr, setInviteErr] = useState('')
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
  const { user, signOut, companies, answerInvitation } = session
  const invites = pendingInvitations(companies ?? [])
  const answer = async (id: string, accept: boolean) => {
    setBusy(id); setInviteErr('')
    try { await answerInvitation(id, accept) } catch (e) { setInviteErr((e as Error).message) } finally { setBusy('') }
  }
  return (
    <div className="user-menu" ref={ref}>
      <button className="avatar-btn" aria-haspopup="menu" aria-expanded={open} title={user.name} onClick={() => setOpen(o => !o)}>
        <UserAvatar userId={user.id} name={user.name} avatar={user.avatar} bare />
        {invites.length > 0 && <span className="invite-dot" aria-label={`${invites.length} pending invitation${invites.length === 1 ? '' : 's'}`} />}
      </button>
      {open && (
        <div className="user-menu-pop" role="menu" onClick={() => setOpen(false)}>
          <div className="user-menu-who"><strong>{user.name}</strong><span className="muted small">{user.email}</span></div>
          {invites.length > 0 && (
            <div className="user-menu-invites" onClick={e => e.stopPropagation()}>
              <span className="muted small">Invitations</span>
              {invites.map(c => (
                <div key={c.id} className="user-menu-invite">
                  <span>{c.name}</span>
                  <button type="button" disabled={busy === c.id} onClick={() => void answer(c.id, true)}>Accept</button>
                  <button type="button" disabled={busy === c.id} onClick={() => void answer(c.id, false)}>Decline</button>
                </div>
              ))}
              {inviteErr && <span className="error small" role="alert">{inviteErr}</span>}
            </div>
          )}
          <Link role="menuitem" to="/account"><Icon name="user" size={18} /> Account</Link>
          {user.is_admin && <Link role="menuitem" to="/company"><Icon name="building" size={18} /> Company admin</Link>}
          {!user.is_admin && <Link role="menuitem" to="/company/catalog"><Icon name="grid" size={18} /> Catalog</Link>}
          {user.platform_admin && <Link role="menuitem" to="/platform"><Icon name="globe" size={18} /> Platform</Link>}
          <button role="menuitem" onClick={signOut}><Icon name="log-out" size={18} /> Sign out</button>
        </div>
      )}
    </div>
  )
}
