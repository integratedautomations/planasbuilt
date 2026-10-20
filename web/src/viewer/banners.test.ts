import { describe, expect, it } from 'vitest'
import { chipSummary, orderBanners } from './banners'
import type { Banner } from './banners'

const b = (id: Banner['id']): Banner => ({ id, level: 'info', text: id })

describe('banner priority', () => {
  it('puts sync/data risks before connectivity before context', () => {
    expect(orderBanners([b('orphaned'), b('offline'), b('viewingOld'), b('foreign'), b('failed'), b('busy')]).map(x => x.id))
      .toEqual(['foreign', 'failed', 'offline', 'viewingOld', 'busy', 'orphaned'])
  })
  it('summarises to the top banner plus a count, or nothing', () => {
    expect(chipSummary([])).toBeNull()
    const s = chipSummary([b('orphaned'), b('offline')])!
    expect(s.top.id).toBe('offline')
    expect(s.more).toBe(1)
    expect(s.ordered).toHaveLength(2)
  })
})
