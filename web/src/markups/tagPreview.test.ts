import { describe, expect, it } from 'vitest'
import { previewTag } from './tagPreview'

const o = { format: 'org' as const, fillGaps: false, orgPadding: 3 }

describe('previewTag', () => {
  it('starts at 1 and advances after each placement', () => {
    expect(previewTag('TS', [], o)).toBe('TS-001')
    expect(previewTag('TS', ['TS-001'], o)).toBe('TS-002')
  })
  it('continues from the highest number unless filling gaps', () => {
    const tags = ['TS-001', 'TS-003']
    expect(previewTag('TS', tags, o)).toBe('TS-004')
    expect(previewTag('TS', tags, { ...o, fillGaps: true })).toBe('TS-002')
  })
  it('follows the project tag format', () => {
    expect(previewTag('CAM', ['CAM7'], { ...o, format: 'plain' })).toBe('CAM8')
    expect(previewTag('CAM', [], { ...o, format: 'dash2' })).toBe('CAM-01')
    expect(previewTag('CAM', [], { ...o, format: 'dash3' })).toBe('CAM-001')
  })
  it('skips numbers taken by devices still waiting for the server', () => {
    expect(previewTag('TS', ['TS-001'], { ...o, pending: 2 })).toBe('TS-004')
  })
  it('counts only its own prefix and handles no prefix', () => {
    expect(previewTag('TS', ['SD-009', '', undefined], o)).toBe('TS-001')
    expect(previewTag('', ['TS-001'], o)).toBe('')
  })
})
