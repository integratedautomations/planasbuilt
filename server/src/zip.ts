// A small streaming ZIP writer (no dependency): entries are written one after another with data descriptors, so a project
// folder of any number of files streams out without being held in memory or spooled to disk.
// Limits of the classic format (no ZIP64): 65,535 entries, and no single offset or file of 4 GiB or more.
import { deflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'

export interface ZipEntry {
  /** Path inside the zip, "/" separated. */
  name: string
  /** Small in-memory content (compressed). Or a stream opener for big files (stored as is; PDFs and photos are compressed already). */
  data?: Buffer | string
  open?: () => Promise<Readable | null>
  /** Modification time (default: now). */
  mtime?: Date
}

export const ZIP_MAX_BYTES = 0xf0000000 // stay well below 4 GiB
export const ZIP_MAX_ENTRIES = 65_000

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
export function crc32(buf: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

function dosTime(d: Date) {
  const y = Math.max(1980, d.getUTCFullYear())
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

const FLAGS = 0x0808 // bit 3: sizes follow the data; bit 11: names are UTF-8

interface Done { name: Buffer; crc: number; csize: number; usize: number; method: number; time: number; date: number; offset: number }

async function* zipChunks(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): AsyncGenerator<Buffer> {
  const done: Done[] = []
  let offset = 0
  const emit = (b: Buffer) => { offset += b.length; return b }
  for await (const e of entries) {
    if (done.length >= ZIP_MAX_ENTRIES) throw new Error('Too many files for one zip')
    const name = Buffer.from(e.name.replace(/^\/+/, ''), 'utf8')
    const { time, date } = dosTime(e.mtime ?? new Date())
    let src: Readable | null = null
    if (e.data === undefined) { src = (await e.open?.()) ?? null; if (!src) continue } // missing file: leave it out
    const method = e.data !== undefined ? 8 : 0
    const startOffset = offset
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(FLAGS, 6); h.writeUInt16LE(method, 8)
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt16LE(name.length, 26)
    yield emit(h); yield emit(name)
    let crc = 0, usize = 0, csize = 0
    if (e.data !== undefined) {
      const raw = Buffer.from(e.data)
      crc = crc32(raw); usize = raw.length
      const c = deflateRawSync(raw)
      csize = c.length
      yield emit(c)
    } else {
      for await (const chunk of src!) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        crc = crc32(b, crc); usize += b.length; csize += b.length
        if (usize >= 0xffffffff || offset + b.length >= 0xffffffff) throw new Error('A file is too large for a zip')
        yield emit(b)
      }
    }
    const d = Buffer.alloc(16)
    d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4); d.writeUInt32LE(csize, 8); d.writeUInt32LE(usize, 12)
    yield emit(d)
    done.push({ name, crc, csize, usize, method, time, date, offset: startOffset })
  }
  const cdStart = offset
  for (const f of done) {
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(FLAGS, 8); c.writeUInt16LE(f.method, 10)
    c.writeUInt16LE(f.time, 12); c.writeUInt16LE(f.date, 14); c.writeUInt32LE(f.crc, 16); c.writeUInt32LE(f.csize, 20); c.writeUInt32LE(f.usize, 24)
    c.writeUInt16LE(f.name.length, 28); c.writeUInt32LE(f.offset, 42)
    yield emit(c); yield emit(f.name)
  }
  const cdSize = offset - cdStart
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(done.length, 8); end.writeUInt16LE(done.length, 10)
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16)
  yield end
}

/** A readable stream of the zip file. Entries whose `open()` returns null are skipped. */
export const zipStream = (entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): Readable => Readable.from(zipChunks(entries))
