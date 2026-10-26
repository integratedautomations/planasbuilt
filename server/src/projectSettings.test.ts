import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_SETTINGS, defaultsPart, formatTag, mergeProjectSettings, missingRequired, nextNumber, publicProjectSettings,
  readProjectSettings, tagNumber, tagPrefixFromTag,
} from './projectSettings.js'

const S = DEFAULT_PROJECT_SETTINGS
const merge = (patch: unknown, ctx = {}) => mergeProjectSettings(S, patch, ctx)

describe('readProjectSettings', () => {
  it('fills in defaults and drops malformed values', () => {
    expect(readProjectSettings({})).toEqual(S)
    expect(readProjectSettings(null)).toEqual(S)
    const r = readProjectSettings({ statuses: [{ key: 'BAD KEY', label: 'x', color: '#fff' }], tag_format: 'nope', photo_quality: 5, locked: 'yes' })
    expect(r.statuses).toEqual(S.statuses)
    expect(r.tag_format).toBe('org')
    expect(r.photo_quality).toBe(0.8)
    expect(r.locked).toBe(false)
  })
})

describe('status list validation', () => {
  const ok = [{ key: 'planned', label: 'Planned', color: '#868e96' }, { key: 'rough', label: 'Rough-in', color: '#f08c00' }]
  it('accepts a valid list in order', () => {
    const r = merge({ statuses: ok })
    expect('value' in r && r.value.statuses.map(s => s.key)).toEqual(['planned', 'rough'])
  })
  it.each([
    ['empty list', []],
    ['bad key', [{ key: 'Has Space', label: 'A', color: '#111111' }]],
    ['duplicate key', [{ key: 'a', label: 'A', color: '#111111' }, { key: 'a', label: 'B', color: '#111111' }]],
    ['duplicate name', [{ key: 'a', label: 'Same', color: '#111111' }, { key: 'b', label: 'same', color: '#111111' }]],
    ['bad color', [{ key: 'a', label: 'A', color: 'red' }]],
    ['blank name', [{ key: 'a', label: ' ', color: '#111111' }]],
  ])('rejects %s', (_n, statuses) => {
    expect('error' in merge({ statuses })).toBe(true)
  })
  it('cannot remove a status that devices use', () => {
    const r = merge({ statuses: ok }, { statusesInUse: ['installed'] })
    expect(r).toMatchObject({ error: expect.stringContaining('installed') })
    expect('value' in merge({ statuses: ok }, { statusesInUse: ['planned', 'rough'] })).toBe(true)
  })
  it('drops required lists of statuses that no longer exist', () => {
    const r = mergeProjectSettings({ ...S, required: { installed: ['ip'], planned: ['tag'] } }, { statuses: ok })
    expect('value' in r && r.value.required).toEqual({ planned: ['tag'] })
  })
})

describe('other settings validation', () => {
  it('validates tag format, quality, sections and the lock', () => {
    expect('error' in merge({ tag_format: 'CAM_1' })).toBe(true)
    expect('error' in merge({ photo_quality: 0.1 })).toBe(true)
    expect('error' in merge({ report: { sections: { nothing: true } } })).toBe(true)
    expect('error' in merge({ locked: 'yes' })).toBe(true)
    expect('error' in merge({ tag_fill_gaps: 1 })).toBe(true)
    const r = merge({ tag_format: 'plain', tag_fill_gaps: true, photo_quality: 0.65, locked: true, report: { sections: { bom: false } } })
    expect('value' in r && r.value).toMatchObject({ tag_format: 'plain', tag_fill_gaps: true, photo_quality: 0.65, locked: true })
    expect('value' in r && r.value.report.sections).toMatchObject({ bom: false, photos: true })
  })
  it('validates required lists and tag prefixes', () => {
    expect('error' in merge({ required: { installed: 'ip' } })).toBe(true)
    expect('error' in merge({ required: { installed: ['bad key!'] } })).toBe(true)
    const id = '11111111-1111-4111-8111-111111111111'
    expect('error' in merge({ tag_prefixes: { [id]: 'bad prefix' } })).toBe(true)
    expect('error' in merge({ tag_prefixes: { notanid: 'AB' } })).toBe(true)
    expect('error' in merge({ tag_prefixes: { [id]: 'AB' } }, { setIds: [] })).toBe(true)
    const r = merge({ tag_prefixes: { [id]: 'cm' } }, { setIds: [id] })
    expect('value' in r && r.value.tag_prefixes).toEqual({ [id]: 'CM' })
  })
  it('keeps the logo and the lock out of the organization defaults and out of the public view', () => {
    const s = { ...S, locked: true, report: { ...S.report, logo_key: 'k.png', logo_type: 'image/png' } }
    expect(Object.keys(defaultsPart(s))).not.toContain('locked')
    expect(JSON.stringify(defaultsPart(s))).not.toContain('k.png')
    const pub = publicProjectSettings(s)
    expect(JSON.stringify(pub)).not.toContain('k.png')
    expect(pub.report).toMatchObject({ has_logo: true })
  })
})

describe('required fields per status', () => {
  const base = { status: 'installed', fields: {}, tag: 'CAM-01', photoCount: 0, applicable: new Set(['ip', 'serial']) }
  const rules = { required: { installed: ['ip', 'serial', 'photo'], tested: ['tag', 'mac'] } }
  it('lists what is missing', () => {
    expect(missingRequired(rules, base)).toEqual(['ip', 'serial', 'photo'])
    expect(missingRequired(rules, { ...base, fields: { ip: '1.2.3.4', serial: ' ' } })).toEqual(['serial', 'photo'])
    expect(missingRequired(rules, { ...base, fields: { ip: '1.2.3.4', serial: 'X' }, photoCount: 1 })).toEqual([])
  })
  it('ignores required fields that do not exist on the device, and statuses without rules', () => {
    expect(missingRequired(rules, { ...base, status: 'tested', tag: '' })).toEqual(['tag'])
    expect(missingRequired(rules, { ...base, status: 'planned' })).toEqual([])
  })
  it('counts numbers and true as filled, false as empty', () => {
    const r = { required: { installed: ['n', 'c'] } }
    const c = { ...base, applicable: new Set(['n', 'c']) }
    expect(missingRequired(r, { ...c, fields: { n: 0, c: true } })).toEqual([])
    expect(missingRequired(r, { ...c, fields: { n: '', c: false } })).toEqual(['n', 'c'])
  })
})

describe('tag format and numbering', () => {
  it('formats the three styles', () => {
    expect(formatTag('CAM', 7, 'dash2', 3)).toBe('CAM-07')
    expect(formatTag('CAM', 7, 'plain', 3)).toBe('CAM7')
    expect(formatTag('CAM', 7, 'dash3', 2)).toBe('CAM-007')
    expect(formatTag('CAM', 7, 'org', 4)).toBe('CAM-0007')
    expect(formatTag('CAM', 120, 'dash2', 2)).toBe('CAM-120')
  })
  it('reads numbers from either style and ignores other prefixes', () => {
    expect(tagNumber('CAM-07', 'CAM')).toBe(7)
    expect(tagNumber('CAM7', 'CAM')).toBe(7)
    expect(tagNumber('CAMX-1', 'CAM')).toBeNull()
    expect(tagNumber('CAM-', 'CAM')).toBeNull()
    expect(tagNumber('DOM-1', 'CAM')).toBeNull()
  })
  it('continues from the highest, or fills the lowest gap', () => {
    expect(nextNumber([1, 2, 4], false)).toBe(5)
    expect(nextNumber([1, 2, 4], true)).toBe(3)
    expect(nextNumber([2, 3], true)).toBe(1)
    expect(nextNumber([], false)).toBe(1)
    expect(nextNumber([1, 2, 3], true)).toBe(4)
  })
  it('finds the prefix of a typed tag', () => {
    expect(tagPrefixFromTag('CAM-07', 'dash2')).toBe('CAM')
    expect(tagPrefixFromTag('CAM7', 'plain')).toBe('CAM')
    expect(tagPrefixFromTag('CAM7', 'dash2')).toBe('CAM7')
  })
})

describe('cable_via_drop', () => {
  it('defaults on, survives malformed values, and validates updates', () => {
    expect(S.cable_via_drop).toBe(true)
    expect(readProjectSettings({ cable_via_drop: 'no' }).cable_via_drop).toBe(true)
    expect(readProjectSettings({ cable_via_drop: false }).cable_via_drop).toBe(false)
    const off = merge({ cable_via_drop: false })
    expect('value' in off && off.value.cable_via_drop).toBe(false)
    expect('error' in merge({ cable_via_drop: 'x' })).toBe(true)
    expect(defaultsPart({ ...S, cable_via_drop: false }).cable_via_drop).toBe(false)
  })
})
