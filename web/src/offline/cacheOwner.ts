/**
 * Whose data is in the local cache (shared-device privacy).
 *
 * The cache tables (projects, plans, PDFs, markups, photos, ...) hold what the signed-in user was allowed to see.
 * `kv['cache:owner']` records that user. When someone else signs in the cache is purged first, and reads that fall
 * back to the cache refuse to answer unless a user has claimed it. Unsent work lives in the outbox, which is
 * kept (it is paused for other users, see owner.ts); the few cache rows that queued uploads need (their markups and photos) are kept
 * too and filtered out of other users' views.
 */
import { db } from './db'

const OWNER_KEY = 'cache:owner'

/** Delete all cached data except the outbox and the photo rows its queued photo work still needs. */
export async function purgeCache() {
  await db.transaction('rw', db.tables, async () => {
    const queued = await db.outbox.toArray()
    const keep = new Set(queued.filter(i => i.kind.startsWith('photo_')).map(i => i.targetId))
    const keepMarkups = new Set(queued.filter(i => i.kind === 'markup_put').map(i => i.targetId))
    await db.markups.filter(m => !keepMarkups.has(m.id)).delete()
    await Promise.all([db.projects, db.documents, db.pdfs, db.layers, db.symbolSets, db.deviceTypes,
      db.products, db.scales, db.kv].map(t => t.clear()))
    await db.attachments.filter(a => !keep.has(a.id)).delete()
    await db.photoBlobs.filter(b => !keep.has(b.attachment_id)).delete()
  })
}

let claimed: string | null = null
let chain: Promise<unknown> = Promise.resolve()

/** Make `userId` the cache owner, purging whatever belonged to someone else. Resolves when the cache is safe to read. */
export function claimCache(userId: string): Promise<void> {
  const run = chain.then(async () => {
    claimed = null
    const owner = (await db.kv.get(OWNER_KEY))?.value
    if (owner !== userId) {
      await purgeCache()
      await db.kv.put({ key: OWNER_KEY, value: userId })
    }
    claimed = userId
  })
  chain = run.catch(() => {})
  return run
}

/** Nobody owns the cache any more (sign-out). */
export function releaseCache() { claimed = null }

/** May cached rows be shown right now? Only after the signed-in user has claimed the cache. */
export async function cacheAllowed(): Promise<boolean> {
  await chain
  return claimed !== null
}
