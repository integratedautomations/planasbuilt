import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api, getToken, setToken, User } from './api'
import { AuthPage } from './pages/AuthPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectPage } from './pages/ProjectPage'
import { ViewerPage } from './pages/ViewerPage'
import { SymbolSetsPage } from './pages/SymbolSetsPage'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(!!getToken())

  useEffect(() => {
    if (getToken()) {
      api<User>('/me').then(setUser).catch(() => setToken(null)).finally(() => setLoading(false))
    }
    const onSignedOut = () => setUser(null)
    window.addEventListener('planmark:signed-out', onSignedOut)
    return () => window.removeEventListener('planmark:signed-out', onSignedOut)
  }, [])

  if (loading) return <div className="center muted">Loading…</div>
  if (!user) return <AuthPage onSignedIn={(token, u) => { setToken(token); setUser(u) }} />

  const signOut = () => { setToken(null); setUser(null) }
  return (
    <Routes>
      <Route path="/" element={<ProjectsPage user={user} onSignOut={signOut} />} />
      <Route path="/projects/:projectId" element={<ProjectPage user={user} />} />
      <Route path="/projects/:projectId/documents/:documentId" element={<ViewerPage />} />
      <Route path="/symbols" element={<SymbolSetsPage user={user} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
