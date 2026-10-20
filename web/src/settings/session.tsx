import { createContext, useContext } from 'react'
import type { User } from '../api'

/** The signed-in user and the sign-out action, for the header menu on every page. */
export const SessionContext = createContext<{ user: User; signOut: () => void } | null>(null)
export const useSession = () => useContext(SessionContext)
