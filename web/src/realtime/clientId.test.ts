import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('getClientId', () => {
  it('is generated per page load and never read from sessionStorage (Duplicate Tab copies it)', async () => {
    const reads: string[] = []
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => { reads.push(k); return 'copied-from-the-original-tab' },
      setItem: () => { reads.push('set') },
    })
    vi.resetModules()
    const { getClientId } = await import('./clientId')
    const id = getClientId()
    expect(id).not.toBe('copied-from-the-original-tab')
    expect(id).toMatch(/\w/)
    expect(getClientId()).toBe(id)
    expect(reads).toEqual([])
  })

  it('differs between page loads', async () => {
    vi.resetModules()
    const a = (await import('./clientId')).getClientId()
    vi.resetModules()
    const b = (await import('./clientId')).getClientId()
    expect(a).not.toBe(b)
  })
})
