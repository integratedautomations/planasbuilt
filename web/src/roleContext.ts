import { createContext, useContext } from 'react'
import type { Role } from './roles'

/** The signed-in person's role in the project being shown (null outside a project), so deep components can hide what a role may not see. */
export const RoleContext = createContext<Role | null>(null)
export const useProjectRole = () => useContext(RoleContext)
