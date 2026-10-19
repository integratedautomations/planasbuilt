import { describe, expect, it } from 'vitest'
import { findImage, makeSyntheticBtx, parseBtx, subjectOf } from './btx'

const PNG1 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

describe('btx import (best effort)', () => {
  it('reads PDF string subjects, literal and UTF-16 hex', () => {
    expect(subjectOf('<</Subj(Smoke \\(Photo\\))/C[1]>>')).toBe('Smoke (Photo)')
    expect(subjectOf('<</Subj<FEFF00480044>>>')).toBe('HD')
    expect(subjectOf('<</Type/Annot>>')).toBe('')
  })
  it('extracts embedded PNG data', () => {
    expect(findImage(Uint8Array.from([1, 2, ...PNG1, 9]))).toMatch(/^data:image\/png;base64,/)
    expect(findImage(Uint8Array.from([1, 2, 3]))).toBeUndefined()
  })
  it('parses a synthetic tool set: titles, subjects from zlib hex data, icon from an Image element', async () => {
    const xml = await makeSyntheticBtx([
      { title: 'Smoke Detector', subject: 'SD', png: PNG1 },
      { title: 'Pull Station', subject: 'PS' },
    ])
    const tools = await parseBtx(xml)
    expect(tools.map(t => [t.title, t.subject, t.decoded, !!t.icon])).toEqual([
      ['Smoke Detector', 'SD', true, true], ['Pull Station', 'PS', true, false]])
  })
  it('still lists tools it cannot decode, and returns nothing for foreign XML', async () => {
    const tools = await parseBtx('<Set><ToolChestItem><Name>Camera &amp; Dome</Name><Raw>nothex!</Raw></ToolChestItem></Set>')
    expect(tools).toEqual([{ title: 'Camera & Dome', subject: '', icon: undefined, decoded: false }])
    expect(await parseBtx('<html><body>hi</body></html>')).toEqual([])
    expect(await parseBtx('not xml at all')).toEqual([])
  })
})
