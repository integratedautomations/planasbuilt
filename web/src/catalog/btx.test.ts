import { describe, expect, it } from 'vitest'
import { findImage, freeTextOf, makeSyntheticBtx, parseBtx, parseBtxSet, shapesToSvg, splitName, subjectOf } from './btx'

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

const hexZ = async (text: string) => {
  const cs = new Blob([new TextEncoder().encode(text) as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return Array.from(new Uint8Array(await new Response(cs).arrayBuffer()), b => b.toString(16).padStart(2, '0')).join('')
}
const rc = (t: string) => `/RC(<?xml version="1.0"?><body><p style="x">${t}</p></body>)`

async function groupedSet() {
  const parent = '<</RD[0.125 0.125 0.125 0.125]/Subj(Rectangle)/TempGroupNesting[(IR421P5 - Single \\(Patient\\) Station)/AAAA/BBBB]/Subtype/Square/Rect[0 0 20 24]/C[0 0 0]/BS<</W 0.25>>/OC(Nurse Call)>>'
  const sq = '<</IC[0 0 1]/FillOpacity 0.5/CA 0.5/Subtype/Square/Rect[0 0 10 10]/C[1 0 0]/BS<</W 0>>>>'
  const circ = '<</IC[0 1 0]/Subtype/Circle/Rect[0 0 8 8]/C[0 0 0]/BS<</W 1>>>>'
  const line = '<</Subtype/Line/L[0 0 6 6]/Rect[0 0 6 6]/C[1 0 0]/BS<</W 2>>>>'
  const txt = `<</DA(1 0 0 rg /Helv 8 Tf)/Subtype/FreeText/Rect[0 0 12 10]${rc('S-P')}>>`
  const child = async (type: string, d: string, x: number, y: number) =>
    `<Child><Type>Bluebeam.PDF.Annotations.Annotation${type}</Type><Raw>${await hexZ(d)}</Raw><X>${x}</X><Y>${y}</Y></Child>`
  const item = `<ToolChestItem Version="1"><Name>OUHXQPKVYGDCJGND</Name><Type>Bluebeam.PDF.Annotations.AnnotationSquare</Type><Raw>${await hexZ(parent)}</Raw><X>0.125</X><Y>0.125</Y>` +
    (await child('Square', sq, -1, -1)) + (await child('Circle', circ, -2, -3)) + (await child('Line', line, -1, -12)) + (await child('FreeText', txt, -2, -4)) + '</ToolChestItem>'
  return `<BluebeamRevuToolSet><Title>${await hexZ('New Nurse Call')}</Title><Name>x</Name>${item}</BluebeamRevuToolSet>`
}

describe('btx grouped tools (Revu 2018+)', () => {
  it('reads name, model, label, layer and title from a grouped tool', async () => {
    const set = await parseBtxSet(await groupedSet())
    expect(set.title).toBe('New Nurse Call')
    expect(set.tools).toHaveLength(1)
    const t = set.tools[0]
    expect(t.name).toBe('Single (Patient) Station')
    expect(t.model).toBe('IR421P5')
    expect(t.label).toBe('S-P')
    expect(t.layer).toBe('Nurse Call')
    expect(t.title).toBe('Single (Patient) Station')
  })
  it('draws every child into an SVG icon', async () => {
    const t = (await parseBtx(await groupedSet()))[0]
    expect(t.icon).toMatch(/^data:image\/svg\+xml;base64,/)
    const svg = t.svg!
    expect(svg).toContain('<svg')
    expect(svg.match(/<rect /g)).toHaveLength(2)
    expect(svg).toContain('<ellipse')
    expect(svg).toContain('<polyline')
    expect(svg).toContain('>S-P</text>')
    expect(svg).toContain('fill="rgb(0,0,255)" fill-opacity="0.25"')
  })
  it('helpers', () => {
    expect(splitName('SF123 - Two-Button Pull-Cord Station')).toEqual({ model: 'SF123', description: 'Two-Button Pull-Cord Station' })
    expect(splitName('Door Strike')).toEqual({ model: '', description: 'Door Strike' })
    expect(freeTextOf(`<<${rc('B&amp;P')}>>`)).toBe('B&P')
    expect(shapesToSvg([])).toBe('')
  })
  it('names an ungrouped text box by its subject, not the random id', async () => {
    const d = `<</Subj(Text Box)/Subtype/FreeText/Rect[0 0 10 8]${rc('X1')}>>`
    const xml = `<S><ToolChestItem><Name>ABCDEFGHIJKLMNOP</Name><Type>Bluebeam.PDF.Annotations.AnnotationFreeText</Type><Raw>${await hexZ(d)}</Raw><X>0</X><Y>0</Y></ToolChestItem></S>`
    const t = (await parseBtx(xml))[0]
    expect([t.name, t.label]).toEqual(['Text Box', 'X1'])
  })
})
