import { createContext, useContext } from 'react'
import type { User } from '../api'
import type { CompanyRow } from '../company/switcher'

/** The signed-in user, the sign-out action and the companies they can work in, for the header on every page. */
export interface Session {
  user: User; signOut: () => void
  /** Companies the user belongs to (all of them for platform admins). */
  companies: CompanyRow[]
  /** Change the active company: reloads the user, projects, catalog and settings, and moves the realtime connection. */
  switchCompany: (id: string) => Promise<void>
  /** Reload the company list (after creating, renaming or archiving one). */
  refreshCompanies: () => Promise<void>
  /** Accept or decline a pending invitation to join a company, then reload the list. */
  answerInvitation: (companyId: string, accept: boolean) => Promise<void>
}
export const SessionContext = createContext<Session | null>(null)
export const useSession = () => useContext(SessionContext)
