import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api, ApiError, getToken, setToken, User } from './api'
import { clearLocalData, db } from './offline/db'
import { cacheUser, cachedUser } from './offline/user'
import { resumeSync, setSyncUser } from './offline/sync'
import { ForeignNotice } from './offline/ForeignNotice'
import { connect as connectRealtime } from './realtime/socket'
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
import { SessionContext } from './settings/session'
import './settings/settings.css'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(!!getToken())
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
    const onSignedOut = () => setUser(null)
    window.addEventListener('planmark:signed-out', onSignedOut)
    return () => window.removeEventListener('planmark:signed-out', onSignedOut)
  }, [])

  useEffect(() => {
    setSyncUser(user ? { id: user.id, name: user.name } : null)
    setPrefsUser(user?.id ?? null)
    if (user) connectRealtime()
  }, [user])

  if (loading) return <div className="center muted">Loading…</div>
  const signedIn = (token: string, u: User) => { setToken(token); cacheUser(u); setUser(u); resumeSync() }
  if (!user) return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage purpose="invite" onSignedIn={signedIn} />} />
      <Route path="/reset/:token" element={<InvitePage purpose="reset" onSignedIn={signedIn} />} />
      <Route path="*" element={<AuthPage onSignedIn={signedIn} />} />
    </Routes>
  )

  const signOut = async () => {
    setToken(null); cacheUser(null); setUser(null)
    // Don't leave one user's plans on a shared device, but never throw away unsent field work.
    if ((await db.outbox.count()) === 0) await clearLocalData()
  }
  return (
    <SessionContext.Provider value={{ user, signOut }}>
    <ForeignNotice />
    <Routes>
      <Route path="/" element={<ProjectsPage user={user} onSignOut={signOut} />} />
      <Route path="/projects/:projectId" element={<ProjectPage user={user} />} />
      <Route path="/projects/:projectId/documents/:documentId" element={<ViewerPage />} />
      <Route path="/projects/:projectId/bom" element={<BomPage user={user} />} />
      <Route path="/symbols" element={<SymbolSetsPage user={user} />} />
      <Route path="/catalog" element={<SymbolSetsPage user={user} />} />
      <Route path="/settings" element={<SettingsPage user={user} onUser={u => { cacheUser(u); setUser(u) }} />} />
      <Route path="/users" element={user.is_admin ? <UsersPage me={user} /> : <Navigate to="/" replace />} />
      <Route path="/invite/:token" element={<Navigate to="/" replace />} />
      <Route path="/reset/:token" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </SessionContext.Provider>
  )
}
