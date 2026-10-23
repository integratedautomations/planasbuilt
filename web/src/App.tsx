import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api, ApiError, getToken, setToken, User } from './api'
import { clearLocalData, db } from './offline/db'
import { cacheUser, cachedUser } from './offline/user'
import { resumeSync, setSyncUser } from './offline/sync'
import { claimCache, purgeCache, releaseCache } from './offline/cacheOwner'
import { ForeignNotice } from './offline/ForeignNotice'
import { connect as connectRealtime, disconnect as disconnectRealtime } from './realtime/socket'
import { setPrefsUser, usePrefs } from './prefs/store'
import { applyTheme } from './prefs/theme'
import { AuthPage } from './pages/AuthPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectPage } from './pages/ProjectPage'
import { ViewerPage } from './pages/ViewerPage'
import { BomPage } from './pages/BomPage'
import { SymbolSetsPage } from './pages/SymbolSetsPage'
import { SettingsPage } from './settings/SettingsPage'
import { UsersPage } from './settings/UsersPage'
import { InvitePage } from './settings/InvitePage'
import { BackupAlert, BackupsPage } from './settings/BackupsPage'
import { SessionContext } from './settings/session'
import './settings/settings.css'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(!!getToken())
  /** The user whose local cache is ready to read (the previous user's data is purged first). */
  const [cacheFor, setCacheFor] = useState<string | null>(null)
  const { theme } = usePrefs()
  useEffect(() => { applyTheme(theme) }, [theme])

  useEffect(() => {
    if (getToken()) {
      api<User>('/me').then(u => { cacheUser(u); setUser(u) }).catch(e => {
        // Offline: keep the token and open with the last known user. Only a real rejection signs out.
        if (e instanceof ApiError) setToken(null)
        else setUser(cachedUser())
      }).finally(() => setLoading(false))
    }
    const onSignedOut = () => { setSyncUser(null); releaseCache(); setUser(null) }
    window.addEventListener('planmark:signed-out', onSignedOut)
    return () => window.removeEventListener('planmark:signed-out', onSignedOut)
  }, [])

  useEffect(() => {
    setSyncUser(user ? { id: user.id, name: user.name } : null)
    setPrefsUser(user?.id ?? null)
    if (!user) { releaseCache(); setCacheFor(null); return }
    let live = true
    claimCache(user.id).then(() => { if (live) setCacheFor(user.id) }).catch(e => { console.error(e); if (live) setCacheFor(user.id) })
    connectRealtime()
    return () => { live = false }
  }, [user])

  if (loading || (user && cacheFor !== user.id)) return <div className="center muted">Loading…</div>
  // The sync user is set synchronously, before anything can drain the outbox under a stale identity.
  const signedIn = (token: string, u: User) => {
    setSyncUser({ id: u.id, name: u.name })
    setToken(token); cacheUser(u); setUser(u); resumeSync()
  }
  if (!user) return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage purpose="invite" onSignedIn={signedIn} />} />
      <Route path="/reset/:token" element={<InvitePage purpose="reset" onSignedIn={signedIn} />} />
      <Route path="*" element={<AuthPage onSignedIn={signedIn} />} />
    </Routes>
  )

  const signOut = async () => {
    setSyncUser(null) // first: nothing may be sent or read as this user from here on
    releaseCache()
    setToken(null); cacheUser(null); setUser(null)
    disconnectRealtime() // the socket is the old user's: the next sign-in opens its own
    // Don't leave one user's plans on a shared device, but never throw away unsent field work:
    // with unsent changes everything else is purged and only what the queued work needs stays.
    if ((await db.outbox.count()) === 0) await clearLocalData()
    else await purgeCache()
  }
  return (
    <SessionContext.Provider value={{ user, signOut }}>
    <ForeignNotice />
    {user.is_admin && <BackupAlert />}
    <Routes>
      <Route path="/" element={<ProjectsPage user={user} onSignOut={signOut} />} />
      <Route path="/projects/:projectId" element={<ProjectPage user={user} />} />
      <Route path="/projects/:projectId/documents/:documentId" element={<ViewerPage />} />
      <Route path="/projects/:projectId/bom" element={<BomPage user={user} />} />
      <Route path="/symbols" element={<SymbolSetsPage user={user} />} />
      <Route path="/catalog" element={<SymbolSetsPage user={user} />} />
      <Route path="/settings" element={<SettingsPage user={user} onUser={u => { cacheUser(u); setUser(u) }} />} />
      <Route path="/users" element={user.is_admin ? <UsersPage me={user} /> : <Navigate to="/" replace />} />
      <Route path="/backups" element={user.is_admin ? <BackupsPage /> : <Navigate to="/" replace />} />
      <Route path="/invite/:token" element={<Navigate to="/" replace />} />
      <Route path="/reset/:token" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </SessionContext.Provider>
  )
}
