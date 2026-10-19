import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { loadCatalog } from '../offline/cache'
import { on as onSocket } from '../realtime/socket'
import { buildCatalog, EMPTY_CATALOG } from './catalog'
import type { Catalog } from './catalog'
import { EMPTY_CATALOG_DATA } from './types'
import type { CatalogData } from './types'

export const CatalogContext = createContext<Catalog>(EMPTY_CATALOG)
export const useCatalogContext = () => useContext(CatalogContext)

/** Loads the catalog (network first, Dexie when offline) and refreshes it when an admin changes it. */
export function useCatalog(): { data: CatalogData; catalog: Catalog; reload: () => Promise<void> } {
  const [data, setData] = useState<CatalogData>(EMPTY_CATALOG_DATA)
  const reload = () => loadCatalog().then(r => setData(r.data)).catch(() => {})
  useEffect(() => {
    void reload()
    return onSocket('symbol_sets', () => { void reload() })
  }, [])
  const catalog = useMemo(() => buildCatalog(data), [data])
  return { data, catalog, reload }
}
