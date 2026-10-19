import { describe, expect, it } from 'vitest'
import { popupFieldOptions, popupRows } from './popupFields'
import type { Markup, SymbolSet } from './types'

const set = { id: 's', name: 'Cameras', fields: [{ key: 'ip', label: 'IP address', type: 'ip' }, { key: 'lens', label: 'Lens', type: 'text' }] } as SymbolSet
const m: Markup = {
  id: 'a', document_id: 'd', page: 1, type: 'device', symbol_set_id: 's', tag: 'CAM-01', status: 'installed',
  geometry: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, style: { stroke: '', fill: '', strokeWidth: 1, opacity: 1, fontSize: 1 },
  text: '', layer_id: null, fields: { ip: '10.0.0.1', serial: '', lens: 'Bullet', rex: false }, created_by_name: 'Dana',
}

describe('popup fields', () => {
  it('offers base, hardware and set fields once each', () => {
    const ids = popupFieldOptions([set, set]).map(o => o.id)
    expect(ids).toContain('tag')
    expect(ids).toContain('field:serial')
    expect(ids.filter(i => i === 'field:ip')).toHaveLength(1)
  })
  it('shows only the chosen fields, in order, skipping empty ones', () => {
    const opts = popupFieldOptions([set])
    const rows = popupRows(m, ['status', 'tag', 'field:serial', 'field:ip', 'area', 'placedBy', 'bogus'], opts, { set })
    expect(rows.map(r => [r.label, r.value])).toEqual([['Status', 'Installed'], ['Tag', 'CAM-01'], ['IP address', '10.0.0.1'], ['Placed by', 'Dana']])
  })
  it('joins the area path and names the product/type', () => {
    const rows = popupRows(m, ['type', 'area'], popupFieldOptions([set]), { set, areaPath: ['First Floor', 'Lobby'] })
    expect(rows.map(r => r.value)).toEqual(['Cameras', 'First Floor > Lobby'])
  })
})
