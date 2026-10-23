import { PDFDocument, concatTransformationMatrix, degrees, lineTo, moveTo, popGraphicsState, pushGraphicsState, rgb, stroke } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { fromPdf } from '../pdfio/coords'
import { extractLines, extractLinesAsync, finalizeSegments, multiply, walkOperatorList } from './vectorLines'
import type { Matrix6, OpsTable } from './vectorLines'

type Seg = [number, number, number, number]

/** Segments as rounded tuples with each one's ends and the list sorted, so comparisons ignore direction and order. */
function norm(flat: ArrayLike<number>): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const a: [number, number] = [Math.round(flat[i] * 10) / 10, Math.round(flat[i + 1] * 10) / 10]
    const b: [number, number] = [Math.round(flat[i + 2] * 10) / 10, Math.round(flat[i + 3] * 10) / 10]
    const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a]
    out.push([p[0], p[1], q[0], q[1]])
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3])
}

async function fixture(rotate = 0) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  if (rotate) page.setRotation(degrees(rotate))
  const color = rgb(0, 0, 0)
  page.drawLine({ start: { x: 100, y: 100 }, end: { x: 300, y: 100 }, thickness: 1, color })
  page.drawLine({ start: { x: 300, y: 100 }, end: { x: 500, y: 100 }, thickness: 1, color }) // collinear, touching: merges
  page.drawLine({ start: { x: 10, y: 10 }, end: { x: 11, y: 10 }, thickness: 1, color }) // too short
  page.drawRectangle({ x: 50, y: 200, width: 100, height: 50, borderColor: color, borderWidth: 1 })
  // 2x scale about a translation, inside a saved state
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(2, 0, 0, 2, 100, 400), moveTo(0, 0), lineTo(50, 0), lineTo(50, 25), stroke(), popGraphicsState())
  // a state that was restored: later paths must not inherit the transform
  page.pushOperators(moveTo(400, 600), lineTo(450, 600), stroke())
  return doc.save()
}

async function load(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  const page = await doc.getPage(1)
  const list = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE })
  const view = page.getViewport({ scale: 1 }).transform as Matrix6
  return { pdfjs, task, page, list, view, ops: pdfjs.OPS as unknown as OpsTable }
}

describe('extractLines on a pdf-lib fixture', () => {
  it('finds lines, a rectangle and a transformed path in page space', async () => {
    const { task, list, view, ops } = await load(await fixture())
    const segs = norm(extractLines(list, ops, view))
    task.destroy()
    // page space is y-down: user y 100 becomes 792 - 100 = 692
    expect(segs).toEqual(norm([
      100, 692, 500, 692, // the two collinear lines, merged into one
      50, 542, 150, 542, 150, 542, 150, 592, 50, 592, 150, 592, 50, 542, 50, 592, // rectangle (user y 200..250)
      100, 392, 200, 392, 200, 392, 200, 342, // transformed: (0,0)-(50,0)-(50,25) * 2 + (100,400)
      400, 192, 450, 192, // after the restore: no transform
    ]))
  })

  it('drops short segments and caps the count keeping the longest', async () => {
    const { task, list, view, ops } = await load(await fixture())
    const all = extractLines(list, ops, view, { minLength: 0.5 })
    expect(all.length / 4).toBe(9) // the 1 pt line comes back
    const capped = norm(extractLines(list, ops, view, { cap: 2 }))
    task.destroy()
    expect(capped).toHaveLength(2)
    expect(capped).toContainEqual([100, 692, 500, 692]) // 400 pt
    expect(capped.some(c => c[1] === c[3] && c[2] - c[0] === 100)).toBe(true) // the next longest, 100 pt
  })

  it('follows the page rotation like the markup layer does', async () => {
    const { task, list, view, ops } = await load(await fixture(90))
    const segs = norm(extractLines(list, ops, view))
    task.destroy()
    const a = fromPdf({ llx: 0, lly: 0, width: 612, height: 792, rotation: 90 }, 100, 100)
    const b = fromPdf({ llx: 0, lly: 0, width: 612, height: 792, rotation: 90 }, 500, 100)
    expect(segs).toContainEqual(norm([a.x, a.y, b.x, b.y])[0])
  })

  it('the async walk gives the same result and honours cancel', async () => {
    const { task, list, view, ops } = await load(await fixture())
    const sync = norm(extractLines(list, ops, view))
    expect(norm((await extractLinesAsync(list, ops, view, {}, async () => {}))!)).toEqual(sync)
    expect(await extractLinesAsync(list, ops, view, {}, async () => {}, () => true)).toBeNull()
    task.destroy()
  })
})

describe('walkOperatorList on a hand-built list', () => {
  const OPS: OpsTable = { save: 10, restore: 11, transform: 12, constructPath: 91, endPath: 28, stroke: 20, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 }
  const path = (...n: number[]) => [OPS.stroke, [new Float32Array(n)], null]
  const identity: Matrix6 = [1, 0, 0, 1, 0, 0]

  it('applies nested transforms, form XObjects and restores', () => {
    const list = {
      fnArray: [OPS.save, OPS.transform, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd, OPS.constructPath, OPS.restore, OPS.constructPath],
      argsArray: [[], [1, 0, 0, 1, 10, 0], [[2, 0, 0, 2, 0, 5], null], path(0, 0, 0, 1, 10, 0), [], path(0, 0, 0, 1, 10, 0), [], path(0, 0, 0, 1, 10, 0)],
    }
    // inside the form: ctm = [2,0,0,2,0,5] then [1,0,0,1,10,0] -> x' = 2x + 10, y' = 2y + 5; the two outside pieces touch and merge
    expect(norm(extractLines(list, OPS, identity, { minLength: 0 }))).toEqual([[0, 0, 20, 0], [10, 5, 30, 5]])
  })

  it('ignores clip-only paths, empty paths and unknown codes', () => {
    const list = {
      fnArray: [OPS.constructPath, OPS.constructPath, OPS.constructPath],
      argsArray: [[OPS.endPath, [new Float32Array([0, 0, 0, 1, 50, 0])], null], [OPS.stroke, [null], null], path(0, 5, 5, 99, 1, 1, 1, 2, 2)],
    }
    expect(extractLines(list, OPS, identity, { minLength: 0 }).length).toBe(0)
  })

  it('flattens curves and closes subpaths', () => {
    const list = {
      fnArray: [OPS.constructPath, OPS.constructPath],
      argsArray: [path(0, 0, 0, 2, 0, 50, 50, 50, 100, 50), path(0, 0, 0, 1, 40, 0, 1, 40, 30, 4)],
    }
    const flat = new Float32Array(walkOnce(list, OPS))
    // the curve is several pieces; the triangle is three (including the closing one)
    expect(flat.length / 4).toBeGreaterThanOrEqual(2 + 3)
    expect(norm(finalizeSegments(flat, { minLength: 0 })).some(s => s[0] === 0 && s[2] === 40 && s[1] === 0 && s[3] === 0)).toBe(true)
  })

  it('multiplies matrices first-then-second', () => {
    expect(multiply([1, 0, 0, 1, 10, 0], [2, 0, 0, 2, 0, 5])).toEqual([2, 0, 0, 2, 20, 5])
  })
})

function walkOnce(list: { fnArray: number[]; argsArray: unknown[] }, ops: OpsTable): number[] {
  const it = walkOperatorList(list as never, ops, [1, 0, 0, 1, 0, 0])
  let r = it.next()
  while (!r.done) r = it.next()
  return r.value
}

describe('finalizeSegments', () => {
  it('merges overlapping and touching collinear pieces but not separate parallel lines', () => {
    const out = norm(finalizeSegments([0, 0, 50, 0, 50, 0, 100, 0, 90, 0, 150, 0, 0, 10, 100, 10, 200, 0, 260, 0]))
    expect(out).toEqual([[0, 0, 150, 0], [0, 10, 100, 10], [200, 0, 260, 0]])
  })

  it('merges vertical and diagonal runs regardless of direction', () => {
    expect(norm(finalizeSegments([5, 0, 5, 40, 5, 80, 5, 40]))).toEqual([[5, 0, 5, 80]])
    expect(norm(finalizeSegments([0, 0, 30, 30, 60, 60, 30, 30]))).toEqual([[0, 0, 60, 60]])
  })
})
