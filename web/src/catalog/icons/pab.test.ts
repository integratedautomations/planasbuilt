import { describe, expect, it } from 'vitest'
import { PAB_ICONS } from './pabIcons'
import { DEVICES, PAB_CATEGORIES, deviceName, folderOf, matchDevice, slugToName } from './pabSpec'
import { SAFE_MAX, SAFE_MIN, validateSvg } from './pabValidate'

const wrap = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${attrs}>${inner}</svg>`

describe('SVG validation', () => {
  it('accepts shape-only 24x24 stroke icons and returns the body', () => {
    const r = validateSvg(wrap('<path d="M5 5L19 19"/><circle cx="12" cy="12" r="4" fill="currentColor"/><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="5" y1="5" x2="9" y2="9"/><polyline points="4,4 8,8"/><polygon points="4,4 8,8 4,8"/><ellipse cx="12" cy="12" rx="5" ry="3"/>'))
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.body).toContain('<ellipse')
    expect(r.outsideSafeArea).toBe(false)
  })
  it.each([
    ['text', '<text x="4" y="10">A</text>'],
    ['script', '<script>alert(1)</script>'],
    ['a group', '<g><path d="M4 4L8 8"/></g>'],
    ['an image', '<image href="http://x/y.png"/>'],
    ['href', '<path d="M4 4L8 8" href="http://x"/>'],
    ['xlink:href', '<path d="M4 4L8 8" xlink:href="#a"/>'],
    ['transform', '<path d="M4 4L8 8" transform="scale(2)"/>'],
    ['style', '<path d="M4 4L8 8" style="fill:red"/>'],
    ['an event handler', '<path d="M4 4L8 8" onclick="x()"/>'],
    ['a url() paint', '<path d="M4 4L8 8" fill="url(#a)"/>'],
    ['a colour paint', '<path d="M4 4L8 8" stroke="#f00"/>'],
    ['a non numeric radius', '<circle cx="1" cy="1" r="calc(2)"/>'],
    ['a bad path', '<path d="M4 4 javascript:1"/>'],
    ['a comment', '<!-- hi --><path d="M4 4L8 8"/>'],
    ['a missing attribute', '<circle cx="4" cy="4"/>'],
    ['an empty icon', ''],
  ])('rejects %s', (_n, inner) => {
    const r = validateSvg(wrap(inner))
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })
  it('rejects a wrong root (viewBox, stroke width, extra attributes, not svg)', () => {
    expect(validateSvg(wrap('<path d="M4 4L8 8"/>').replace('0 0 24 24', '0 0 32 32')).ok).toBe(false)
    expect(validateSvg(wrap('<path d="M4 4L8 8"/>').replace('1.8', '3')).ok).toBe(false)
    expect(validateSvg(wrap('<path d="M4 4L8 8"/>', ' onload="x()"')).ok).toBe(false)
    expect(validateSvg('<div></div>').ok).toBe(false)
  })
  it('flags artwork outside the safe area but still accepts it', () => {
    const r = validateSvg(wrap('<path d="M1 12H23"/>'))
    expect(r.ok).toBe(true)
    expect(r.outsideSafeArea).toBe(true)
    expect(r.bounds).toMatchObject({ x0: 1, x1: 23 })
    expect(validateSvg(wrap(`<path d="M${SAFE_MIN} ${SAFE_MIN}L${SAFE_MAX} ${SAFE_MAX}"/>`)).outsideSafeArea).toBe(false)
  })
  it('passes every shipped icon (option A and B)', () => {
    for (const p of PAB_ICONS) for (const o of ['a', 'b'] as const) {
      const r = validateSvg(wrap(p[o]))
      expect(r.errors, `${p.slug}-${o}`).toEqual([])
      expect(r.outsideSafeArea, `${p.slug}-${o} safe area`).toBe(false)
    }
  })
})

describe('names', () => {
  it('derives a readable name from the slug', () => {
    expect(slugToName('access-rex-motion')).toBe('REX Motion')
    expect(slugToName('fire-co')).toBe('CO')
    expect(slugToName('camera-ptz')).toBe('PTZ')
    expect(slugToName('network-poe-injector')).toBe('PoE Injector')
    expect(slugToName('network-data-x2')).toBe('Data x2')
    expect(slugToName('fire-heat-ror')).toBe('Heat ROR')
    expect(slugToName('general-jbox')).toBe('J-Box')
  })
  it('uses explicit names where the slug reads poorly', () => {
    expect(deviceName('fire-co')).toBe('CO Detector')
    expect(deviceName('access-rex-motion')).toBe('REX Motion')
    expect(deviceName('fire-horn-strobe')).toBe('Horn/Strobe')
  })
})

describe('device spec', () => {
  it('covers exactly the shipped icons: 145 devices in 10 categories', () => {
    expect(DEVICES).toHaveLength(145)
    expect(PAB_ICONS).toHaveLength(145)
    expect(new Set(DEVICES.map(d => d.slug))).toEqual(new Set(PAB_ICONS.map(p => p.slug)))
    for (const c of PAB_CATEGORIES) expect(PAB_ICONS.filter(p => p.folder === c.folder).length, c.folder).toBeGreaterThan(0)
    for (const p of PAB_ICONS) expect(folderOf(p.slug)).toBe(p.folder)
    for (const c of PAB_CATEGORIES) expect(DEVICES.some(d => d.slug === c.setIcon), c.setIcon).toBe(true)
  })
  it('has unique names and, within a category, unique tag prefixes made of letters and digits', () => {
    expect(new Set(DEVICES.map(d => deviceName(d.slug).toLowerCase())).size).toBe(145)
    for (const c of PAB_CATEGORIES) {
      const ps = DEVICES.filter(d => folderOf(d.slug) === c.folder).map(d => d.prefix)
      expect(new Set(ps).size, c.folder).toBe(ps.length)
      for (const p of ps) expect(p).toMatch(/^[A-Z0-9]{1,6}$/)
    }
  })
  it('recognises each device by its own name, within its category too', () => {
    for (const d of DEVICES) {
      expect(matchDevice(deviceName(d.slug))?.slug, d.slug).toBe(d.slug)
      expect(matchDevice(deviceName(d.slug), folderOf(d.slug))?.slug, d.slug).toBe(d.slug)
    }
  })
  it('has sensible default mounts', () => {
    const m = (s: string) => DEVICES.find(d => d.slug === s)!.mount
    for (const s of ['fire-smoke', 'fire-heat', 'fire-co', 'fire-speaker', 'network-wap', 'camera-dome', 'camera-fisheye', 'camera-ptz', 'intrusion-motion', 'intrusion-glass-break', 'paging-speaker-ceiling', 'automation-occupancy']) expect(m(s), s).toBe('ceiling')
    for (const s of ['access-reader', 'access-keypad', 'fire-pull', 'access-rex-button', 'fire-horn-strobe', 'intercom-door-audio', 'automation-thermostat', 'intrusion-keypad', 'paging-speaker-wall']) expect(m(s), s).toBe('wall')
    for (const s of ['fire-facp', 'access-controller', 'access-power-supply', 'network-switch', 'network-rack', 'camera-nvr', 'general-jbox', 'paging-amplifier']) expect(m(s), s).toBe('square')
  })
  it('gives cameras, motion sensors and speakers coverage, and nothing else needs it', () => {
    const c = (s: string) => DEVICES.find(d => d.slug === s)!.coverage
    for (const s of ['camera-dome', 'camera-bullet', 'camera-ptz', 'intrusion-motion', 'paging-speaker-ceiling', 'paging-speaker-wall']) {
      expect(c(s), s).toMatchObject({ on: true })
      expect(c(s)!.angle).toBeGreaterThanOrEqual(1)
      expect(c(s)!.angle).toBeLessThanOrEqual(360)
      expect(c(s)!.range_ft).toBeGreaterThan(0)
    }
    expect(c('fire-smoke')).toBeUndefined()
    expect(c('access-reader')).toBeUndefined()
  })
})
