// File storage: local disk (default) or an S3-compatible bucket (AWS, Cloudflare R2, MinIO...).
// A stored key says where its file lives: a relative path ("Acme/Projects/.../Rev 01 - ....pdf", or the old bare
// "<uuid>.pdf") = local disk under filesDir, "s3:<bucket>/<prefix/>path" = that S3 bucket and object path (so changing
// the bucket/prefix setting later does not orphan old files). Legacy "s3:name.pdf" keys resolve against the current settings.
// New files get a readable path built by fileLayout.ts; relocate() moves one when the names around it change; remove()
// moves a file to _trash/<stamp>/<same path> and purgeTrash() deletes it after the retention period.
// Switching the backend only affects new files; old keys keep resolving to where they were written.
import { constants as fsConstants, createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { copyFile, link, mkdir, open as openFile, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import { buildPath, isSafeRelPath, TRASH_DIR, withSuffix } from './fileLayout.js'
import type { FileCtx } from './fileLayout.js'

export type { FileCtx } from './fileLayout.js'

export interface S3Config {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secret: string
  /** Path-style addressing (endpoint/bucket/key), needed by MinIO and some gateways. */
  pathStyle: boolean
  /** Optional key prefix inside the bucket. */
  prefix: string
}

export interface StorageConfig { backend: 'local' | 's3'; s3: S3Config | null }

export const LOCAL_CONFIG: StorageConfig = { backend: 'local', s3: null }

/** Returns a human-readable problem with an S3 config, or null when it looks usable. */
export function validateS3Config(c: Partial<S3Config> | null | undefined): string | null {
  if (!c) return 'S3 settings are missing'
  if (c.endpoint) {
    try {
      const u = new URL(c.endpoint)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Endpoint must start with https:// (or http://)'
    } catch { return 'Endpoint is not a valid URL' }
  }
  const bucket = String(c.bucket ?? '')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return 'Bucket must be 3-63 lowercase letters, digits, dots or hyphens'
  if (!String(c.region ?? '').trim()) return 'Region is required (use "auto" for Cloudflare R2)'
  if (!String(c.accessKeyId ?? '').trim()) return 'Access key ID is required'
  if (!String(c.secret ?? '').trim()) return 'Secret access key is required'
  if (c.prefix && /(^\/|\.\.)/.test(String(c.prefix))) return 'Prefix must not start with / or contain ..'
  return null
}

/** The slice of the S3 client the storage uses; tests pass a fake. */
export interface S3Like { send(command: any): Promise<any> }
export type S3Factory = (c: S3Config) => S3Like

const defaultFactory: S3Factory = c => new S3Client({
  region: c.region || 'auto',
  endpoint: c.endpoint || undefined,
  forcePathStyle: c.pathStyle,
  credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secret },
})

const S3_PREFIX = 's3:'
const isNotFound = (e: any) =>
  e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404

const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/
const stampTime = (s: string) => { const m = STAMP_RE.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null }
const encodeCopySource = (bucket: string, key: string) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`

export class Storage {
  private clients = new Map<string, S3Like>()
  private root: string

  constructor(
    readonly filesDir: string,
    /** Backend choice of a company (undefined = the install's first company); read on every write so a settings change applies at once. */
    private getConfig: (companyId?: string | null) => Promise<StorageConfig> = async () => LOCAL_CONFIG,
    private factory: S3Factory = defaultFactory,
    /** S3 settings of every company, used to read files that live in a bucket even when the active backend is local again. */
    private getS3: () => Promise<S3Config | S3Config[] | null> = async () => null,
    /** Days a removed file waits in _trash before it is purged; 0 (the default here) deletes at once. */
    private getTrashDays: () => Promise<number> = async () => 0,
  ) {
    mkdirSync(filesDir, { recursive: true })
    this.root = path.resolve(filesDir)
  }

  private client(c: S3Config): S3Like {
    const sig = JSON.stringify([c.endpoint, c.bucket, c.region, c.accessKeyId, c.secret, c.pathStyle])
    let cl = this.clients.get(sig)
    if (!cl) { cl = this.factory(c); this.clients.set(sig, cl) }
    return cl
  }

  private s3Key(c: S3Config, name: string) { return (c.prefix ? c.prefix.replace(/\/+$/, '') + '/' : '') + name }

  /** Where a stored s3: key lives: the bucket and object key recorded in it, or the current settings for legacy keys. */
  private async locate(key: string): Promise<{ c: S3Config; bucket: string; objectKey: string }> {
    const rest = key.slice(S3_PREFIX.length)
    const slash = rest.indexOf('/')
    // Credentials come from whichever company's S3 settings name the bucket recorded in the key.
    const c = await this.s3For(slash > 0 ? rest.slice(0, slash) : null)
    if (slash > 0) return { c, bucket: rest.slice(0, slash), objectKey: rest.slice(slash + 1) }
    return { c, bucket: c.bucket, objectKey: this.s3Key(c, rest) }
  }

  private async s3List(): Promise<S3Config[]> {
    const got = await this.getS3()
    let list = (Array.isArray(got) ? got : got ? [got] : []).filter(c => !validateS3Config(c))
    if (!list.length) { const s3 = (await this.getConfig()).s3; list = s3 && !validateS3Config(s3) ? [s3] : [] }
    return list
  }

  private async s3For(bucket: string | null): Promise<S3Config> {
    const list = await this.s3List()
    const c = (bucket && list.find(x => x.bucket === bucket)) || list[0]
    if (!c) throw new Error(`S3 storage is not configured: ${validateS3Config(null)}`)
    return c
  }

  /** Absolute path of a local key inside filesDir. Throws for anything that could leave it (.., absolute, backslash, NUL). */
  private localPath(key: string) {
    if (!isSafeRelPath(key)) throw new Error('Invalid file key')
    const p = path.resolve(this.root, ...key.split('/').filter(Boolean))
    if (!p.startsWith(this.root + path.sep)) throw new Error('Invalid file key')
    return p
  }

  /** The path of a key below the files root / bucket prefix, whichever backend it is on (what fileLayout produces). */
  async pathOf(key: string): Promise<string> {
    if (!key.startsWith(S3_PREFIX)) return key
    const { c, objectKey } = await this.locate(key)
    const pre = c.prefix ? c.prefix.replace(/\/+$/, '') + '/' : ''
    return pre && objectKey.startsWith(pre) ? objectKey.slice(pre.length) : objectKey
  }

  /** Picks `rel` or `rel (2)`, `rel (3)`... that does not exist yet (names compared without case: SMB shares are case-insensitive). */
  private async freeLocal(rel: string, claim: boolean): Promise<string> {
    for (let n = 1, enoent = 0; n < 10_000; n++) {
      const cand = withSuffix(rel, n)
      const abs = this.localPath(cand)
      try {
        await mkdir(path.dirname(abs), { recursive: true })
        const lower = path.basename(abs).toLowerCase()
        if ((await readdir(path.dirname(abs))).some(f => f.toLowerCase() === lower)) continue
        if (claim) await (await openFile(abs, 'wx')).close()
        return cand
      } catch (e: any) {
        if (e?.code === 'EEXIST') continue
        // A concurrent remove pruned the (empty) folder between the steps: make it again.
        if (e?.code === 'ENOENT' && enoent++ < 20) { n--; continue }
        throw e
      }
    }
    throw new Error('Could not find a free file name')
  }

  private async freeS3(cl: S3Like, bucket: string, c: S3Config, rel: string): Promise<{ rel: string; objectKey: string }> {
    for (let n = 1; n < 10_000; n++) {
      const cand = withSuffix(rel, n), objectKey = this.s3Key(c, cand)
      try { await cl.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey })) } catch (e) { if (isNotFound(e)) return { rel: cand, objectKey }; throw e }
    }
    throw new Error('Could not find a free file name')
  }

  /**
   * Stores a new file on the company's backend and returns the key to keep in the database.
   * Pass a FileCtx to get a readable path (a taken name gets " (2)"); a bare extension makes the old flat `<uuid>.<ext>`.
   */
  async save(arg: string | FileCtx, body: Readable | Buffer | Uint8Array, companyId?: string | null): Promise<string> {
    const rel = typeof arg === 'string' ? `${randomUUID()}.${arg.replace(/^\./, '')}` : buildPath(arg)
    const cfg = await this.getConfig(companyId)
    if (cfg.backend === 's3' && cfg.s3) return this.putS3(cfg.s3, rel, body, typeof arg !== 'string')
    const free = await this.freeLocal(rel, true)
    const dest = this.localPath(free)
    try {
      if (body instanceof Readable) await pipeline(body, createWriteStream(dest))
      else await writeFile(dest, body)
    } catch (e) { await unlink(dest).catch(() => {}); throw e }
    return free
  }

  private async putS3(c: S3Config, rel: string, body: Readable | Buffer | Uint8Array, unique: boolean): Promise<string> {
    const err = validateS3Config(c)
    if (err) throw new Error(`S3 storage is not configured: ${err}`)
    let buf: Buffer | Uint8Array, tmp: string | null = null
    if (body instanceof Readable) {
      // Spool to disk first: S3 needs the length up front, and big PDFs should not sit in a stream buffer.
      tmp = path.join(tmpdir(), `pm-up-${randomUUID()}`)
      await pipeline(body, createWriteStream(tmp))
      buf = await readFile(tmp)
    } else buf = body
    try {
      const cl = this.client(c)
      const objectKey = unique ? (await this.freeS3(cl, c.bucket, c, rel)).objectKey : this.s3Key(c, rel)
      await cl.send(new PutObjectCommand({ Bucket: c.bucket, Key: objectKey, Body: buf, ContentLength: buf.length }))
      return `${S3_PREFIX}${c.bucket}/${objectKey}`
    } finally { if (tmp) unlink(tmp).catch(() => {}) }
  }

  async exists(key: string): Promise<boolean> { return (await this.size(key)) !== null }

  /** Size in bytes, or null when the file is missing (or the key is not valid). */
  async size(key: string): Promise<number | null> {
    if (key.startsWith(S3_PREFIX)) {
      try {
        const { c, bucket, objectKey } = await this.locate(key)
        const r = await this.client(c).send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }))
        return Number(r?.ContentLength ?? 0)
      } catch (e) { if (isNotFound(e)) return null; throw e }
    }
    try { return (await stat(this.localPath(key))).size } catch { return null }
  }

  /** A readable stream of the file, or null when missing. */
  async open(key: string): Promise<Readable | null> {
    if (key.startsWith(S3_PREFIX)) {
      try {
        const { c, bucket, objectKey } = await this.locate(key)
        const r = await this.client(c).send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }))
        const b = r?.Body
        if (!b) return null
        return b instanceof Readable ? b : Readable.from(Buffer.from(await b.transformToByteArray()))
      } catch (e) { if (isNotFound(e)) return null; throw e }
    }
    let p: string
    try { p = this.localPath(key) } catch { return null }
    return existsSync(p) ? createReadStream(p) : null
  }

  async read(key: string): Promise<Buffer | null> {
    const s = await this.open(key)
    if (!s) return null
    const chunks: Buffer[] = []
    for await (const c of s) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks)
  }

  /** Removes empty folders from `dir` up to (not including) the files root. */
  private async pruneDirs(dir: string) {
    let d = dir
    while (d.startsWith(this.root + path.sep)) {
      try { await rmdir(d) } catch { return }
      d = path.dirname(d)
    }
  }

  /**
   * Moves a file to a new readable path on the same backend and returns its new key. `commit(newKey)` runs once the copy
   * exists and should update the database (in one transaction); if it throws, the copy is removed and the original is untouched.
   * Only after `commit` succeeds is the original deleted, so a crash never leaves a database key pointing at nothing.
   * Idempotent: moving a file to the place it already has returns its key.
   */
  async relocate(key: string, newPath: string, commit?: (newKey: string) => Promise<void>): Promise<string> {
    if (!isSafeRelPath(newPath)) throw new Error('Invalid target path')
    if (key.startsWith(S3_PREFIX)) return this.relocateS3(key, newPath, commit)
    const src = this.localPath(key)
    if (!existsSync(src)) throw new Error('File missing')
    if (key === newPath) return key
    if (key.toLowerCase() === newPath.toLowerCase()) {
      // Only the case differs. On a case-insensitive disk (Windows, macOS, some shares) the new name is the file itself:
      // rename it in place through a temporary name. On a case-sensitive disk it is a different path: the normal move below.
      const dest = this.localPath(newPath)
      await mkdir(path.dirname(dest), { recursive: true })
      if (existsSync(dest)) {
        const tmp = `${src}.${randomUUID()}.tmp`
        await rename(src, tmp)
        await rename(tmp, dest)
        try { await commit?.(newPath) } catch (e) { await rename(dest, src).catch(() => {}); throw e }
        return newPath
      }
    }
    let rel = '', dest = ''
    for (let n = 1; n < 10_000; n++) {
      rel = await this.freeLocal(newPath, false)
      dest = this.localPath(rel)
      try { await link(src, dest) } catch (e: any) {
        if (e?.code === 'EEXIST' || e?.code === 'ENOENT' && existsSync(src)) continue // taken meanwhile / folder pruned meanwhile
        await copyFile(src, dest, fsConstants.COPYFILE_EXCL) // disks without hard links
      }
      break
    }
    try { await commit?.(rel) } catch (e) { await unlink(dest).catch(() => {}); await this.pruneDirs(path.dirname(dest)); throw e }
    await unlink(src).catch(() => {})
    await this.pruneDirs(path.dirname(src))
    return rel
  }

  private async relocateS3(key: string, newPath: string, commit?: (newKey: string) => Promise<void>): Promise<string> {
    const { c, bucket, objectKey } = await this.locate(key)
    const cl = this.client(c)
    const target = this.s3Key(c, newPath)
    if (target === objectKey) return key
    const free = await this.freeS3(cl, bucket, c, newPath)
    await cl.send(new CopyObjectCommand({ Bucket: bucket, Key: free.objectKey, CopySource: encodeCopySource(bucket, objectKey) }))
    const newKey = `${S3_PREFIX}${bucket}/${free.objectKey}`
    try { await commit?.(newKey) } catch (e) {
      await cl.send(new DeleteObjectCommand({ Bucket: bucket, Key: free.objectKey })).catch(() => {})
      throw e
    }
    await cl.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })).catch(() => {})
    return newKey
  }

  /**
   * Takes a file away. By default it moves to `_trash/<stamp>/<same path>` (undo is a file move; purgeTrash() empties it after
   * the retention period). With `hard`, or when the retention is 0 days, it is deleted at once. Best effort: a file that is
   * already gone is not an error.
   */
  async remove(key: string | null | undefined, opts: { hard?: boolean } = {}): Promise<void> {
    if (!key) return
    try {
      const keep = opts.hard ? 0 : await this.getTrashDays().catch(() => 0)
      if (key.startsWith(S3_PREFIX)) {
        const { c, bucket, objectKey } = await this.locate(key)
        const cl = this.client(c)
        const rel = await this.pathOf(key)
        if (keep > 0 && !rel.startsWith(`${TRASH_DIR}/`)) {
          const free = await this.freeS3(cl, bucket, c, `${TRASH_DIR}/${stampOf()}/${rel}`)
          await cl.send(new CopyObjectCommand({ Bucket: bucket, Key: free.objectKey, CopySource: encodeCopySource(bucket, objectKey) }))
        }
        await cl.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
        return
      }
      const src = this.localPath(key)
      if (keep > 0 && !key.startsWith(`${TRASH_DIR}/`) && existsSync(src)) {
        const rel = await this.freeLocal(`${TRASH_DIR}/${stampOf()}/${key}`, false)
        await rename(src, this.localPath(rel))
      } else await unlink(src)
      await this.pruneDirs(path.dirname(src))
    } catch { /* already gone or backend unreachable */ }
  }

  /** Deletes trash older than `days` days (local disk and every configured bucket). Returns how many trash batches were purged. */
  async purgeTrash(days: number, now = Date.now()): Promise<number> {
    const cutoff = now - Math.max(0, days) * 86_400_000
    let purged = 0
    try {
      for (const e of await readdir(path.join(this.root, TRASH_DIR), { withFileTypes: true })) {
        const t = stampTime(e.name)
        if (!e.isDirectory() || t === null || t > cutoff) continue
        await rm(path.join(this.root, TRASH_DIR, e.name), { recursive: true, force: true })
        purged++
      }
    } catch { /* no trash yet */ }
    const seen = new Set<string>()
    for (const c of await this.s3List().catch(() => [] as S3Config[])) {
      const sig = `${c.bucket}/${c.prefix}`
      if (seen.has(sig)) continue
      seen.add(sig)
      try {
        const cl = this.client(c)
        const base = this.s3Key(c, `${TRASH_DIR}/`)
        const top = await cl.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: base, Delimiter: '/' }))
        for (const cp of (top?.CommonPrefixes ?? []) as { Prefix?: string }[]) {
          const stamp = (cp.Prefix ?? '').slice(base.length).replace(/\/$/, '')
          const t = stampTime(stamp)
          if (t === null || t > cutoff) continue
          let token: string | undefined
          do {
            const page: any = await cl.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: cp.Prefix, ContinuationToken: token }))
            for (const o of (page?.Contents ?? []) as { Key: string }[]) await cl.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: o.Key }))
            token = page?.IsTruncated ? page.NextContinuationToken : undefined
          } while (token)
          purged++
        }
      } catch { /* bucket unreachable: try again next time */ }
    }
    return purged
  }

  /** Writes, checks and deletes a small probe object. Throws with a readable message when anything fails. */
  async testS3(c: S3Config): Promise<void> {
    const err = validateS3Config(c)
    if (err) throw new Error(err)
    const cl = this.factory(c)
    const key = this.s3Key(c, `planmark-test-${randomUUID()}.txt`)
    const text = Buffer.from('planmark connection test')
    try {
      await cl.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: text, ContentLength: text.length }))
      const head = await cl.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }))
      if (Number(head?.ContentLength) !== text.length) throw new Error('The bucket returned an unexpected object size')
      await cl.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }))
    } catch (e: any) {
      throw new Error(e?.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : String(e?.message ?? e))
    }
  }
}
