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
