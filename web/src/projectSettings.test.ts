import { afterEach, describe, expect, it } from 'vitest'
import { STATUSES } from './markups/types'
import type { FieldDef, Markup, SymbolSet } from './markups/types'
import { tagPrefixFor } from './catalog/catalog'
import {
  activeSettings, applyProjectSettings, DEFAULT_SETTINGS, describeBlocked, describeMissing, gateStatus, lockedFor, missingForStatus,
  normalizeSettings, photoQuality,
} from './projectSettings'

afterEach(() => { applyProjectSettings(undefined) })

const defs: FieldDef[] = [{ key: 'ip', label: 'IP address', type: 'ip' }]
const mk = (o: Partial<Markup> & { id: string }) => ({ type: 'device', status: 'planned', fields: {}, tag: '', ...o }) as unknown as Markup

describe('normalizeSettings', () => {
  it('completes anything with defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('junk')).toEqual(DEFAULT_SETTINGS)
    const s = normalizeSettings({ statuses: [{ key: 'a', label: 'A', color: '#111111' }, { nope: 1 }], tag_format: 'plain', photo_quality: 9, locked: true, report: { sections: { bom: false } } })
    expect(s.statuses).toEqual([{ key: 'a', label: 'A', color: '#111111' }])
    expect(s.tag_format).toBe('plain')
    expect(s.photo_quality).toBe(0.8)
    expect(s.locked).toBe(true)
    expect(s.report.sections).toMatchObject({ bom: false, photos: true })
  })
})

describe('applyProjectSettings', () => {
  it('replaces the shared status list in place and falls back to the four defaults', () => {
    const list = STATUSES
    applyProjectSettings({ statuses: [{ key: 'rough', label: 'Rough-in', color: '#f08c00' }, { key: 'done', label: 'Done', color: '#2f9e44' }] })
    expect(STATUSES).toBe(list) // same array: every importer sees the change
    expect(STATUSES.map(s => s.value)).toEqual(['rough', 'done'])
    expect(STATUSES[0]).toEqual({ value: 'rough', label: 'Rough-in', color: '#f08c00' })
    applyProjectSettings(undefined)
    expect(STATUSES.map(s => s.value)).toEqual(['planned', 'installed', 'tested', 'punch'])
  })
  it('exposes photo quality and the active settings', () => {
    applyProjectSettings({ photo_quality: 0.55 })
    expect(photoQuality()).toBe(0.55)
    expect(activeSettings().photo_quality).toBe(0.55)
  })
  it('lets a project override the tag prefix of a symbol set', () => {
    const set = { id: 'AAAAAAAA-1111-4111-8111-111111111111', tag_prefix: 'CAM', fields: [] } as unknown as SymbolSet
    expect(tagPrefixFor(set, undefined)).toBe('CAM')
    applyProjectSettings({ tag_prefixes: { [set.id.toLowerCase()]: 'CM' } })
    expect(tagPrefixFor(set, undefined)).toBe('CM')
    expect(tagPrefixFor(set, { tag_prefix: 'DM' } as any)).toBe('DM') // a device type's own prefix wins
  })
})

describe('required fields', () => {
  const s = normalizeSettings({ required: { installed: ['ip', 'serial', 'photo'], tested: ['tag', 'gone'] } })
  it('lists what a device still needs, using labels', () => {
    const m = mk({ id: 'a', fields: { serial: 'S1' } })
    expect(missingForStatus('installed', m, defs, 0, s)).toEqual([{ key: 'ip', label: 'IP address' }, { key: 'photo', label: 'a photo' }])
    expect(missingForStatus('installed', mk({ id: 'a', fields: { ip: '1.1.1.1', serial: 'S' } }), defs, 2, s)).toEqual([])
  })
  it('leaves the photo rule to the server when the count is unknown, and skips fields the device lacks', () => {
    expect(missingForStatus('installed', mk({ id: 'a', fields: { ip: '1.1.1.1', serial: 'S' } }), defs, null, s)).toEqual([])
    expect(missingForStatus('installed', mk({ id: 'a' }), [], 1, s).map(x => x.key)).toEqual(['serial']) // no ip field on this device
    expect(missingForStatus('tested', mk({ id: 'a', tag: 'CAM-01' }), defs, null, s)).toEqual([])
    expect(missingForStatus('tested', mk({ id: 'a', tag: ' ' }), defs, null, s).map(x => x.key)).toEqual(['tag'])
  })
  it('describes a refusal in one sentence', () => {
    applyProjectSettings({ required: { installed: ['ip', 'serial', 'photo'] } })
    const need = missingForStatus('installed', mk({ id: 'a' }), defs, 0)
    expect(describeMissing('installed', need)).toBe('Installed needs IP address, Serial # and a photo')
  })
  it('gates a batch: blocked devices are named, devices already at the status pass', () => {
    applyProjectSettings({ required: { installed: ['ip'] } })
    const a = mk({ id: 'a', tag: 'CAM-01' }), b = mk({ id: 'b', tag: 'CAM-02', fields: { ip: '10.0.0.1' } }), c = mk({ id: 'c', tag: 'CAM-03', status: 'installed' })
    const g = gateStatus([a, b, c], 'installed', () => defs)
    expect(g.allowed.map(m => m.id)).toEqual(['b', 'c'])
    expect(g.blocked.map(x => x.markup.id)).toEqual(['a'])
    expect(describeBlocked('installed', g.blocked)).toBe('Installed needs IP address.')
    const many = gateStatus([a, mk({ id: 'd', tag: 'CAM-04' })], 'installed', () => defs)
    expect(describeBlocked('installed', many.blocked)).toContain('2 devices were not changed (CAM-01, CAM-04)')
    expect(describeBlocked('installed', [])).toBe('')
  })
})

describe('project lock', () => {
  it('locks everyone but admins', () => {
    expect(lockedFor('editor', { locked: true })).toBe(true)
    expect(lockedFor('field', { locked: true })).toBe(true)
    expect(lockedFor('admin', { locked: true })).toBe(false)
    expect(lockedFor('editor', { locked: false })).toBe(false)
  })
})
