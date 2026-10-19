/** Shared-device rule: queued writes belong to the user who made them and are never sent under another account. */
import type { OutboxItem } from './db'

export interface CurrentUser { id: string; name: string }

export interface ForeignInfo { count: number; userId: string; name: string }

/** True when `item` was created by someone else than `user`. Items from before owners were recorded count as the user's. */
export const isForeign = (item: Pick<OutboxItem, 'userId'>, user: CurrentUser | null) =>
  !!user && !!item.userId && item.userId !== user.id

/** Summary of queued items that belong to another user, or null when there are none (or nobody is signed in). */
export function foreignInfo(items: Pick<OutboxItem, 'userId' | 'userName'>[], user: CurrentUser | null): ForeignInfo | null {
  const theirs = items.filter(i => isForeign(i, user))
  if (!theirs.length) return null
  const names = new Set(theirs.map(i => i.userName || 'another user'))
  return { count: theirs.length, userId: theirs[0].userId!, name: names.size === 1 ? [...names][0] : 'other users' }
}

export function foreignNotice(f: ForeignInfo): string {
  return `${f.count} unsent change${f.count === 1 ? '' : 's'} from ${f.name}: sign in as ${f.name} to send them, or discard.`
}
