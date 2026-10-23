import { describe, expect, it } from 'vitest'
import type { Markup } from '../markups/types'
import type { ScheduleRow } from '../schedule/rows'
import { bulkField, bulkStatus, deviceCell, displayOrder, filterDevices, groupDevices, NO_DEVICE_FILTER, planOptions, sortDevices } from './deviceList'

function row(o: Partial<ScheduleRow> & { id: string }): ScheduleRow {
  return {
    markup: { id: o.id, type: 'device', fields: o.fields ?? {}, status: o.status ?? '' } as unknown as Markup,
    type: 'device', isDevice: true, tag: '', setId: '', setName: '', typeId: '', typeName: '', productId: '', productName: '',
    status: '', statusLabel: '', areaPath: [], areaText: '', documentId: 'd1', documentName: 'E-101', page: 1, sheet: '',
    placedBy: '', placedAt: '', editedBy: '', editedAt: '', photos: 0, fields: {}, value: '', valueNum: null, unit: '', stackSize: 1, ...o,
  }
}

const rows = [
  row({ id: 'a', tag: 'CAM-10', setId: 's1', setName: 'Cameras', status: 'planned', statusLabel: 'Planned', documentId: 'd1', documentName: 'E-101', page: 2, areaText: 'Floor 1 > Lobby', areaPath: ['Floor 1', 'Lobby'], fields: { ip: '10.0.0.2' }, photos: 3 }),
  row({ id: 'b', tag: 'CAM-2', setId: 's1', setName: 'Cameras', status: 'installed', statusLabel: 'Installed', documentId: 'd1', documentName: 'E-101', page: 1, areaText: 'Floor 1 > Hall', areaPath: ['Floor 1', 'Hall'], fields: { ip: '10.0.0.10', mac: 'AA' } }),
  row({ id: 'c', tag: 'FA-1', setId: 's2', setName: 'Fire Alarm', status: '', statusLabel: '', documentId: 'd2', documentName: 'A-200', page: 1, fields: { serial: 'X9' }, photos: 1 }),
]

describe('deviceList', () => {
  it('reads IP, MAC and serial from fields', () => {
    expect(deviceCell(rows[0], 'ip')).toBe('10.0.0.2')
    expect(deviceCell(rows[1], 'mac')).toBe('AA')
    expect(deviceCell(rows[2], 'serial')).toBe('X9')
    expect(deviceCell(rows[2], 'photos')).toBe('1')
  })

  it('filters by search, set, status, plan and area', () => {
    expect(filterDevices(rows, NO_DEVICE_FILTER)).toHaveLength(3)
    expect(filterDevices(rows, { ...NO_DEVICE_FILTER, search: '10.0.0.10' }).map(r => r.id)).toEqual(['b'])
    expect(filterDevices(rows, { ...NO_DEVICE_FILTER, setId: 's2' }).map(r => r.id)).toEqual(['c'])
    expect(filterDevices(rows, { ...NO_DEVICE_FILTER, status: 'installed' }).map(r => r.id)).toEqual(['b'])
    expect(filterDevices(rows, { ...NO_DEVICE_FILTER, planId: 'd1' }).map(r => r.id)).toEqual(['a', 'b'])
    expect(filterDevices(rows, { ...NO_DEVICE_FILTER, area: 'Floor 1' }).map(r => r.id)).toEqual(['a', 'b'])
    expect(filterDevices(rows, { ...NO_DEVICE_FILTER, area: 'Floor 1 > Hall', planId: 'd2' })).toEqual([])
  })

  it('sorts naturally, numerically for page, with blanks last both ways', () => {
    expect(sortDevices(rows, 'tag', 'asc').map(r => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortDevices(rows, 'tag', 'desc').map(r => r.id)).toEqual(['c', 'a', 'b'])
    expect(sortDevices(rows, 'page', 'desc').map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(sortDevices(rows, 'ip', 'asc').map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(sortDevices(rows, 'ip', 'desc').map(r => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortDevices(rows, 'photos', 'asc').map(r => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('groups by plan, set, status and room, empty group last', () => {
    expect(groupDevices(rows, 'none')).toHaveLength(1)
    expect(groupDevices(rows, 'plan').map(g => [g.label, g.rows.length])).toEqual([['A-200', 1], ['E-101', 2]])
    expect(groupDevices(rows, 'set').map(g => g.label)).toEqual(['Cameras', 'Fire Alarm'])
    expect(groupDevices(rows, 'status').map(g => g.label)).toEqual(['Installed', 'Planned', 'No status'])
    const rooms = groupDevices(rows, 'room')
    expect(rooms.map(g => g.label)).toEqual(['Floor 1 > Hall', 'Floor 1 > Lobby', 'No room'])
    expect(displayOrder(rooms)).toEqual(['b', 'a', 'c'])
  })

  it('lists plans once', () => {
    expect(planOptions(rows)).toEqual([{ id: 'd2', name: 'A-200' }, { id: 'd1', name: 'E-101' }])
  })

  it('bulk status skips devices already at that status', () => {
    const ms = rows.map(r => r.markup)
    const res = bulkStatus(ms, 'installed')
    expect(res.changed.map(m => m.id)).toEqual(['a', 'c'])
    expect(res.changed.every(m => m.status === 'installed')).toBe(true)
    expect(res.skipped).toBe(1)
  })

  it('bulk field sets a shared field but never a unique one on several devices', () => {
    const ms = rows.map(r => r.markup)
    const res = bulkField(ms, 'manufacturer', 'Axis')
    expect(res.changed).toHaveLength(3)
    expect(res.changed.every(m => m.fields?.manufacturer === 'Axis')).toBe(true)
    expect(bulkField(ms, 'serial', '1')).toEqual({ changed: [], skipped: 3 })
    expect(bulkField(ms, 'camera_ip', '1.1.1.1', 'ip').changed).toEqual([])
    expect(bulkField([ms[0]], 'serial', '1').changed).toHaveLength(1)
  })
})
