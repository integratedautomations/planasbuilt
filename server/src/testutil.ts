import { PDFDocument } from 'pdf-lib'

/** A real, parseable PDF with `pages` pages. `tag` makes the bytes unique. */
export async function makePdf(pages = 1, tag = ''): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 300])
  if (tag) doc.setTitle(tag)
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}
