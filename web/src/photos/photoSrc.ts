/**
 * Which URL a photo should be shown from. Pure so the stale-image rules can be tested.
 * `saved` is the blob URL of the markup the user just saved in this session: it wins for the
 * annotated view, because the server copy is still the previous markup until the queued upload lands.
 */
export interface PhotoSrcInput {
  local?: string
  saved?: string
  original: boolean
  unsynced: boolean // pending, queued writes, or offline
  serverUrl: string
}
export function pickPhotoSrc(i: PhotoSrcInput): string {
  if (!i.original && i.saved) return i.saved
  if (i.local && i.unsynced) return i.local
  return i.serverUrl
}
