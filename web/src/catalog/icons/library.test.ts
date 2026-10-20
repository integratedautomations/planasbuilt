import { describe, expect, it } from 'vitest'
import { ICON_CATEGORIES, ICONS, iconById, iconDataUrl, iconSvg, searchIcons } from './library'

describe('icon library', () => {
  it('has about seventy uniquely named icons covering every category', () => {
    expect(ICONS.length).toBeGreaterThanOrEqual(68)
    expect(new Set(ICONS.map(i => i.id)).size).toBe(ICONS.length)
    for (const c of ICON_CATEGORIES) expect(ICONS.some(i => i.category === c), c).toBe(true)
    for (const id of ['cam-dome', 'cam-ptz', 'fa-smoke', 'fa-heat', 'fa-co', 'fa-pull', 'ac-reader', 'ac-maglock', 'in-pir', 'net-wap', 'net-jack-4', 'av-ceiling', 'pw-ups', 'g-jbox', 'g-conduit'])
      expect(iconById(id), id).toBeDefined()
  })
  it('draws every icon in one colour with balanced markup', () => {
    for (const i of ICONS) {
      const svg = iconSvg(i, '#ff0000')
      expect(svg, i.id).not.toContain('currentColor')
      expect(svg.match(/</g)?.length, i.id).toBe(svg.match(/>/g)?.length)
      expect((svg.match(/<(path|circle|rect)/g) ?? []).length, i.id).toBeGreaterThan(0)
      expect(i.body.replace(/"[^"]*"/g, ''), i.id).not.toMatch(/#[0-9a-f]{3,6}/i)
    }
  })
  it('makes data URLs the server accepts, white by default', () => {
    const url = iconDataUrl(iconById('fa-smoke')!)
    expect(url).toMatch(/^data:image\/svg\+xml[;,]/)
    expect(decodeURIComponent(url)).toContain('stroke="#ffffff"')
    expect(url.length).toBeLessThan(5000)
  })
  it('searches names, keywords and categories', () => {
    expect(searchIcons('smoke').map(i => i.id)).toContain('fa-smoke')
    expect(searchIcons('rj45 quad').map(i => i.id)).toEqual(['net-jack-4'])
    expect(searchIcons('', 'Power').every(i => i.category === 'Power')).toBe(true)
    expect(searchIcons('zzzz')).toEqual([])
  })
})

import { ICON_CLASSES, autoIconFor, classForName } from './classIcons'
describe('class icons', () => {
  it('gives every class two distinct, well formed options', () => {
    expect(new Set(ICON_CLASSES.map(c => c.id)).size).toBe(ICON_CLASSES.length)
    for (const c of ICON_CLASSES) {
      expect(c.a.body, c.id).not.toBe(c.b.body)
      for (const i of [c.a, c.b]) {
        const svg = iconSvg(i, '#000')
        expect(svg.match(/</g)?.length, i.id).toBe(svg.match(/>/g)?.length)
        expect(i.body.length, i.id).toBeGreaterThan(20)
      }
    }
  })
  it('recognises Revu tool names', () => {
    const cases: Record<string, string> = { 'Horn Strobe': 'fa-horn-strobe', 'Smoke Detector': 'fa-smoke', 'Smoke/CO': 'fa-co', 'Data Jack x2': 'net-jack',
      'PTZ Camera': 'cam-ptz', 'Fisheye': 'cam-fisheye', 'Request to Exit': 'ac-rex', 'Single Mag Lock': 'ac-maglock', 'Glass Break Detector': 'in-glass',
      'Wifi Access Point': 'net-wap', 'Speaker Strobe': 'fa-speaker-strobe', 'Network Video Recorder': 'video-nvr' }
    for (const [n, id] of Object.entries(cases)) expect(classForName(n)?.id, n).toBe(id)
    expect(classForName('Footing')).toBeUndefined()
    expect(autoIconFor('Card Reader')).toMatch(/^data:image\/svg\+xml/)
  })
})
