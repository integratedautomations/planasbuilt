import { PDFDocument } from 'pdf-lib'

/** A real, parseable PDF with `pages` pages. `tag` makes the bytes unique. */
export async function makePdf(pages = 1, tag = ''): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 300])
  if (tag) doc.setTitle(tag)
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

/** An in-memory S3 client for tests: put, head, get, delete, copy and list (with delimiter and paging ignored beyond one page). */
export function fakeS3Client(objects: Map<string, Buffer>) {
  const nf = (name: string) => Object.assign(new Error('not found'), { name })
  return {
    async send(cmd: any) {
      const n = cmd.constructor.name, i = cmd.input
      const at = (k: string) => `${i.Bucket}/${k}`
      if (n === 'PutObjectCommand') { objects.set(at(i.Key), Buffer.from(i.Body)); return {} }
      if (n === 'HeadObjectCommand') {
        const o = objects.get(at(i.Key))
        if (!o) throw nf('NotFound')
        return { ContentLength: o.length }
      }
      if (n === 'GetObjectCommand') {
        const o = objects.get(at(i.Key))
        if (!o) throw nf('NoSuchKey')
        return { Body: { transformToByteArray: async () => new Uint8Array(o) } }
      }
      if (n === 'DeleteObjectCommand') { objects.delete(at(i.Key)); return {} }
      if (n === 'CopyObjectCommand') {
        // CopySource is "<bucket>/<key with every segment url-encoded>"
        const o2 = objects.get(i.CopySource.split('/').map((p: string) => decodeURIComponent(p)).join('/'))
        if (!o2) throw nf('NoSuchKey')
        objects.set(at(i.Key), Buffer.from(o2))
        return {}
      }
      if (n === 'ListObjectsV2Command') {
        const pre = `${i.Bucket}/${i.Prefix ?? ''}`
        const keys = [...objects.keys()].filter(k => k.startsWith(pre)).map(k => k.slice(i.Bucket.length + 1))
        if (i.Delimiter) {
          const cps = new Set<string>(), contents: { Key: string }[] = []
          for (const k of keys) {
            const rest = k.slice((i.Prefix ?? '').length), d = rest.indexOf(i.Delimiter)
            if (d >= 0) cps.add((i.Prefix ?? '') + rest.slice(0, d + 1)); else contents.push({ Key: k })
          }
          return { CommonPrefixes: [...cps].map(Prefix => ({ Prefix })), Contents: contents, IsTruncated: false }
        }
        return { Contents: keys.map(Key => ({ Key })), IsTruncated: false }
      }
      throw new Error('unexpected ' + n)
    },
  }
}
