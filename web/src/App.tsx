import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, getToken, setToken, User } from './api'
import { clearLocalData, db } from './offline/db'
import { cacheUser, cachedUser } from './offline/user'
import { resumeSync, setSyncUser } from './offline/sync'
import { claimCache, purgeCache, releaseCache } from './offline/cacheOwner'
import { ForeignNotice } from './offline/ForeignNotice'
import { DataSafetyBanner, SignInRecoveryNotice } from './offline/DataSafety'
import { requestPersistence } from './offline/storagePersist'
import { connect as connectRealtime, disconnect as disconnectRealtime, setSocketCompany } from './realtime/socket'
import { getActiveCompanyId, setActiveCompanyId, subscribeActiveCompany } from './company/activeCompany'
import { acceptInvitation, declineInvitation, listCompanies, listInvitations } from './company/api'
import { adoptCompany, pathAfterSwitch } from './company/switcher'
import type { CompanyRow } from './company/switcher'
import { setPrefsUser, usePrefs } from './prefs/store'
import { applyTheme } from './prefs/theme'
import { AuthPage } from './pages/AuthPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectPage } from './pages/ProjectPage'
import { ViewerPage } from './pages/ViewerPage'
import { BomPage } from './pages/BomPage'
import { DevicesPage } from './devices/DevicesPage'
import { WiringPage } from './wiring/WiringPage'
import { InvitePage } from './settings/InvitePage'
import { BackupAlert } from './settings/BackupsPage'
import { ProjectShell } from './shell/ProjectShell'
import { AccountPage, CompanyAdminPage, PlatformPage } from './shell/AreaPages'
import { legacyRedirect } from './shell/projectTabs'
import { ProjectMembersPage } from './pages/ProjectMembersPage'
import { ProjectSettingsPage } from './pages/ProjectSettingsPage'
import { SessionContext } from './settings/session'
import './settings/settings.css'

/** The signed-in user. A remembered company that is no longer usable (403) is forgotten and the server picks one. */
export async function fetchMe(): Promise<User> {
  try { return await api<User>('/me') } catch (e) {
    if (e instanceof ApiError && e.status === 403 && getActiveCompanyId()) { setActiveCompanyId(null); return api<User>('/me') }
    throw e
  }
}

/** Old routes (/settings, /users, /preferences, ...) forward to where the page lives now. */
function LegacyRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate to={legacyRedirect(pathname, search) ?? '/'} replace />
}

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const [user, setUser] = useState<User | null>(null)
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  /** Bumped by an explicit company switch: remounts the pages so everything reloads for the new company. */
  const [epoch, setEpoch] = useState(0)
  /** Requests to change company in flight (explicit switches): the "company changed elsewhere" listener stays quiet meanwhile. */
  const switching = useRef(0)
  /** Latest company-change request; an older /me answer that arrives after a newer request started is ignored. */
  const seq = useRef(0)
  const userRef = useRef<User | null>(null)
  userRef.current = user
  const [loading, setLoading] = useState(!!getToken())
  /** The user whose local cache is ready to read (the previous user's data is purged first). */
  const [cacheFor, setCacheFor] = useState<string | null>(null)
  const { theme } = usePrefs()
  useEffect(() => { applyTheme(theme) }, [theme])

  useEffect(() => {
    if (getToken()) {
      fetchMe().then(u => { adoptCompany(u); cacheUser(u); setUser(u) }).catch(e => {
        // Offline: keep the token and open with the last known user. Only a real rejection signs out.
        if (e instanceof ApiError) setToken(null)
        else setUser(cachedUser())
      }).finally(() => setLoading(false))
    }
    const onSignedOut = () => { setSyncUser(null); releaseCache(); setActiveCompanyId(null); setUser(null) }
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
    void requestPersistence()
    return () => { live = false }
  }, [user])

  const refreshCompanies = useCallback(async () => {
    if (!user) return
    try {
      const [rows, invites] = await Promise.all([
        listCompanies(user.platform_admin ? {} : { mine: true }),
        listInvitations().catch(() => []),
      ])
      // Pending invitations ride along as non-switchable rows; their id is the invitation id (used to accept or decline).
      setCompanies([...rows, ...invites.map(i => ({ id: i.id, name: i.company.name, slug: '', archived: false, created_at: i.created_at, role: null, member: false, can_create_projects: false, active: false, pending: true }))])
    } catch { /* offline: keep what we had */ }
  }, [user?.id, user?.platform_admin])
  useEffect(() => { void refreshCompanies() }, [refreshCompanies])

  const switchCompany = useCallback(async (id: string) => {
    if (!user || id === getActiveCompanyId()) return
    // Restore to the company we were last confirmed in (not an unconfirmed one from a switch still in flight).
    const previous = userRef.current?.company?.id ?? null
    const my = ++seq.current
    switching.current++
    try {
      setActiveCompanyId(id)
      const next = await api<User>('/me')
      if (my !== seq.current) return // a newer switch took over: its answer decides
      adoptCompany(next)
      setSocketCompany(next.company?.id ?? id)
      cacheUser(next); setUser(next)
      await refreshCompanies()
      if (my !== seq.current) return
      const to = pathAfterSwitch(location.pathname)
      if (to !== location.pathname) navigate(to, { replace: true })
      setEpoch(n => n + 1)
    } catch (e) {
      if (my === seq.current) setActiveCompanyId(previous)
      throw e
    } finally { switching.current-- }
  }, [user, location.pathname, navigate, refreshCompanies])

  const answerInvitation = useCallback(async (id: string, accept: boolean) => {
    await (accept ? acceptInvitation(id) : declineInvitation(id))
    await refreshCompanies()
  }, [refreshCompanies])

  // The active company changed without the switcher (e.g. opening a project of another company): refresh who we are there.
  useEffect(() => subscribeActiveCompany(id => {
    if (switching.current > 0 || !id || !user || user.company?.id === id) return
    const my = ++seq.current
    fetchMe().then(u => {
      if (my !== seq.current) return
      cacheUser(u); setUser(u); setSocketCompany(id)
      // Reload everything for the new company (the catalog and symbol sets were loaded for the previous one).
      setEpoch(n => n + 1)
    }).catch(() => {})
  }), [user])

  if (loading || (user && cacheFor !== user.id)) return <div className="center muted">Loading…</div>
  // The sync user is set synchronously, before anything can drain the outbox under a stale identity.
  const signedIn = (token: string, u: User) => {
    setSyncUser({ id: u.id, name: u.name })
    adoptCompany(u)
    setToken(token); cacheUser(u); setUser(u); resumeSync()
  }
  if (!user) return (
    <>
    <SignInRecoveryNotice />
    <Routes>
      <Route path="/invite/:token" element={<InvitePage purpose="invite" onSignedIn={signedIn} />} />
      <Route path="/reset/:token" element={<InvitePage purpose="reset" onSignedIn={signedIn} />} />
      <Route path="*" element={<AuthPage onSignedIn={signedIn} />} />
    </Routes>
    </>
  )

  const signOut = async () => {
    setSyncUser(null) // first: nothing may be sent or read as this user from here on
    releaseCache()
    setToken(null); cacheUser(null); setActiveCompanyId(null); setUser(null); setCompanies([])
    disconnectRealtime() // the socket is the old user's: the next sign-in opens its own
    // Don't leave one user's plans on a shared device, but never throw away unsent field work:
    // with unsent changes everything else is purged and only what the queued work needs stays.
    if ((await db.outbox.count()) === 0) await clearLocalData()
    else await purgeCache()
  }
  return (
    <SessionContext.Provider value={{ user, signOut, companies, switchCompany, refreshCompanies, answerInvitation }}>
    <ForeignNotice />
    <DataSafetyBanner />
    {user.is_admin && <BackupAlert />}
    <Routes key={epoch}>
      <Route path="/" element={<ProjectsPage user={user} onSignOut={signOut} />} />
      <Route path="/projects/:projectId/documents/:documentId" element={<ViewerPage />} />
      <Route path="/projects/:projectId" element={<ProjectShell user={user} />}>
        <Route index element={<ProjectPage user={user} />} />
        <Route path="devices" element={<DevicesPage user={user} />} />
        <Route path="wiring" element={<WiringPage user={user} />} />
        <Route path="bom" element={<BomPage user={user} />} />
        <Route path="members" element={<ProjectMembersPage user={user} />} />
        <Route path="settings" element={<ProjectSettingsPage user={user} />} />
      </Route>
      <Route path="/account/*" element={<AccountPage user={user} onUser={u => { cacheUser(u); setUser(u) }} />} />
      <Route path="/company/*" element={user.is_admin || user.company ? <CompanyAdminPage user={user} /> : <Navigate to="/" replace />} />
      <Route path="/platform/*" element={user.platform_admin ? <PlatformPage /> : <Navigate to="/" replace />} />
      {['/preferences', '/settings', '/users', '/catalog', '/symbols', '/backups', '/companies'].map(p =>
        <Route key={p} path={p} element={<LegacyRedirect />} />)}
      <Route path="/invite/:token" element={<Navigate to="/" replace />} />
      <Route path="/reset/:token" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </SessionContext.Provider>
  )
}
