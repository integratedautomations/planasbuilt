import { describe, expect, it } from 'vitest'
import { copyFields, copyMarkup } from './copy'
import type { Markup, SymbolSet } from './types'

const style = { stroke: '#000', fill: '', strokeWidth: 1, opacity: 1, fontSize: 12 }
const camera: Markup = {
  id: 'a', document_id: 'doc', page: 2, type: 'device', symbol_set_id: 'cams', tag: 'CAM-04', status: 'installed',
  geometry: { x: 10, y: 20, width: 24, height: 24, rotation: 0, fov: { direction: -90, angle: 90, range: 150 } },
  style, text: '', layer_id: 'L1',
  fields: { manufacturer: 'Hikvision', model: 'DS-2CD', lens: 'Bullet', ip: '10.0.0.4', mac: 'AA:BB', serial: 'S123', nvr_port_ip: '1', channel: 3 },
  created_by: 'u1', created_by_name: 'Dana', created_at: 't', updated_by: 'u1', updated_at: 't', version: 5, photo_count: 3,
}

describe('copyFields', () => {
  it('drops ip, mac, serial and any key matching them', () => {
    expect(copyFields(camera.fields)).toEqual({ manufacturer: 'Hikvision', model: 'DS-2CD', lens: 'Bullet', channel: 3 })
  })
  it('also drops fields the set declares as IP', () => {
    const set = { fields: [{ key: 'addr', label: 'Address', type: 'ip' }] } as SymbolSet
    expect(copyFields({ addr: '1.2.3.4', zone: 'A' }, set)).toEqual({ zone: 'A' })
  })
  it('passes undefined through', () => {
    expect(copyFields(undefined)).toBeUndefined()
  })
})

describe('copyMarkup', () => {
  it('gives a device no tag, default status and cleared unique fields, keeping product and settings', () => {
    const c = copyMarkup(camera, { dx: 30, dy: 40 })
    expect(c.id).not.toBe(camera.id)
    expect(c.tag).toBe('')
    expect(c.status).toBe('planned')
    expect(c.symbol_set_id).toBe('cams')
    expect(c.fields).toEqual({ manufacturer: 'Hikvision', model: 'DS-2CD', lens: 'Bullet', channel: 3 })
    expect(c.geometry).toMatchObject({ x: 40, y: 60, fov: { angle: 90 } })
    expect(c.created_by).toBeUndefined()
    expect(c.version).toBeUndefined()
    expect(c.photo_count).toBeUndefined()
  })
  it('does not mutate the original', () => {
    copyMarkup(camera, { dx: 5 })
    expect(camera.geometry.x).toBe(10)
    expect(camera.fields?.ip).toBe('10.0.0.4')
  })
  it('moves to another page and keeps non-device data as is', () => {
    const rect: Markup = { id: 'r', document_id: 'doc', page: 1, type: 'rect', geometry: { x: 0, y: 0, width: 5, height: 5, rotation: 0 }, style, text: 'note', layer_id: null, tag: 'x' }
    const c = copyMarkup(rect, { page: 4 })
    expect(c).toMatchObject({ page: 4, text: 'note', tag: 'x', type: 'rect' })
  })
})
