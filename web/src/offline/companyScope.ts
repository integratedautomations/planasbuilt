/**
 * Company scoping for the offline cache.
 *
 * Catalog tables (symbol sets, device types, products, cable types) and the project list belong to one company.
 * Their rows are stamped with `company_id` when stored, reads only return the active company's rows and a refresh
 * replaces only that company's rows. Per-project data (plans, markups, photos, scales, layers) is keyed by project
 * id already, and the outbox replays per project, so neither depends on the active company.
 */
import type { Table } from 'dexie'
import { getActiveCompanyId } from '../company/activeCompany'

export type Scoped = { company_id?: string }

/** The company whose cache is in use right now ('' when none is chosen yet: such rows only match each other). */
export const scopeId = () => getActiveCompanyId() ?? ''

/** Stamp rows with their company. A row that already names one keeps it (a project fetched on its own). */
export const stamp = <T extends Scoped>(rows: T[], company = scopeId()): T[] =>
  rows.map(r => ({ ...r, company_id: r.company_id ?? company }))

/** Rows of `company` (rows from before scoping existed have no company_id and are never shown). */
export const inScope = <T extends Scoped>(rows: T[], company = scopeId()): T[] => rows.filter(r => r.company_id === company)

/** Replace one company's rows in `table` with `rows`; other companies' rows stay. Runs inside the caller's transaction. */
export async function replaceScoped<T extends Scoped>(table: Table<T, any>, rows: T[], company = scopeId()) {
  await table.filter(r => r.company_id === company || r.company_id === undefined).delete()
  await table.bulkPut(stamp(rows, company))
}

export async function readScoped<T extends Scoped>(table: Table<T, any>, company = scopeId()): Promise<T[]> {
  return inScope(await table.toArray(), company)
}
