import { describe, expect, it } from 'vitest'
import { pickPhotoSrc } from './photoSrc'

describe('pickPhotoSrc', () => {
  const base = { original: false, unsynced: false, serverUrl: 'srv' }
  it('shows the just-saved markup instead of the stale server copy', () => {
    expect(pickPhotoSrc({ ...base, local: 'old', saved: 'new' })).toBe('new')
  })
  it('still shows the original when asked', () => {
    expect(pickPhotoSrc({ ...base, original: true, local: 'orig', saved: 'new', unsynced: true })).toBe('orig')
  })
  it('falls back to local blob while unsynced, server otherwise', () => {
    expect(pickPhotoSrc({ ...base, local: 'l', unsynced: true })).toBe('l')
    expect(pickPhotoSrc({ ...base, local: 'l' })).toBe('srv')
  })
})
