import { describe, expect, it } from 'vitest'
import { ICON_CATEGORIES, ICONS, iconById, iconDataUrl, iconSvg, searchIcons } from './library'
import { CLASS_ICONS, ICON_CLASSES, autoIconFor, classForName, searchClasses } from './classIcons'

describe('icon library', () => {
  it('holds the 10 categories and all 290 options with unique ids', () => {
    expect(ICON_CATEGORIES).toHaveLength(10)
    expect(ICONS).toHaveLength(290)
    expect(new Set(ICONS.map(i => i.id)).size).toBe(ICONS.length)
    for (const c of ICON_CATEGORIES) expect(ICONS.some(i => i.category === c), c).toBe(true)
    expect(CLASS_ICONS).toHaveLength(290)
  })
  it('renders every icon as a well formed SVG data URL', () => {
    for (const i of ICONS) {
      const svg = iconSvg(i, '#fff')
      expect(svg.match(/</g)?.length, i.id).toBe(svg.match(/>/g)?.length)
      expect(svg).toContain('stroke-width="1.8"')
      expect(iconDataUrl(i)).toMatch(/^data:image\/svg\+xml;utf8,/)
    }
    expect(iconSvg(iconById('fire-smoke-a')!, '#123456')).not.toContain('currentColor')
  })
  it('searches names, keywords and categories', () => {
    expect(searchIcons('photoelectric').some(i => i.id === 'fire-smoke-a')).toBe(true)
    expect(searchIcons('', 'Cameras').every(i => i.category === 'Cameras')).toBe(true)
    expect(searchIcons('zzzz')).toEqual([])
    expect(searchClasses('license plate').map(c => c.id)).toContain('camera-lpr')
    expect(searchClasses('rex').map(c => c.id)).toEqual(expect.arrayContaining(['access-rex-motion', 'access-rex-button']))
    expect(searchClasses('smoke', 'Fire Alarm').every(c => c.category === 'Fire Alarm')).toBe(true)
    expect(searchClasses('', 'Network').length).toBe(ICON_CLASSES.filter(c => c.category === 'Network').length)
  })
})

describe('class icons', () => {
  it('gives every class two distinct options', () => {
    expect(ICON_CLASSES).toHaveLength(145)
    expect(new Set(ICON_CLASSES.map(c => c.id)).size).toBe(145)
    for (const c of ICON_CLASSES) expect(c.a.body, c.id).not.toBe(c.b.body)
  })
  it('recognises every device by its own name', () => {
    for (const c of ICON_CLASSES) expect(classForName(c.name)?.id, c.name).toBe(c.id)
  })
  it('recognises Revu tool names', () => {
    const cases: Record<string, string> = { 'Horn Strobe': 'fire-horn-strobe', 'Smoke Detector': 'fire-smoke', 'Smoke/CO': 'fire-co', 'Data Jack x2': 'network-data-x2',
      'PTZ Camera': 'camera-ptz', 'Fisheye': 'camera-fisheye', 'Request to Exit': 'access-rex-motion', 'Single Mag Lock': 'access-maglock', 'Glass Break Detector': 'intrusion-glass-break',
      'Wifi Access Point': 'network-wap', 'Speaker Strobe': 'fire-speaker-strobe', 'Network Video Recorder': 'camera-nvr', 'Card Reader': 'access-reader',
      'Duct Smoke Detector': 'fire-duct', 'Paging Horn': 'paging-horn', 'Door Contact': 'access-door-contact', 'Keypad': 'access-keypad', 'Alarm Keypad': 'intrusion-keypad',
      'Dome Camera': 'camera-dome', 'IP Camera': 'camera-bullet', 'Data Jack': 'network-data', 'Ceiling Speaker': 'paging-speaker-ceiling', 'Wall Speaker': 'paging-speaker-wall',
      'Pull Station': 'fire-pull', 'Dome Light': 'nursecall-dome-light', 'Thermostat': 'automation-thermostat', 'Motion Detector': 'intrusion-motion' }
    for (const [n, id] of Object.entries(cases)) expect(classForName(n)?.id, n).toBe(id)
    expect(classForName('Footing')).toBeUndefined()
    expect(classForName('')).toBeUndefined()
    expect(autoIconFor('Card Reader')).toMatch(/^data:image\/svg\+xml/)
  })
})
