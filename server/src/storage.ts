// File storage: local disk (default) or an S3-compatible bucket (AWS, Cloudflare R2, MinIO...).
// A stored key says where its file lives: bare "name.pdf" = local disk, "s3:<bucket>/<prefix/>name.pdf" = that S3 bucket
// and object path (so changing the bucket/prefix setting later does not orphan old files). Legacy "s3:name.pdf" keys
// resolve against the current settings.
// Switching the backend only affects new files; old keys keep resolving to where they were written.
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'

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

export class Storage {
  private clients = new Map<string, S3Like>()

  constructor(
    readonly filesDir: string,
    /** Current backend choice; read on every write so a settings change applies at once. */
    private getConfig: () => Promise<StorageConfig> = async () => LOCAL_CONFIG,
    private factory: S3Factory = defaultFactory,
    /** S3 settings used to read files that live in the bucket even when the active backend is local again. */
    private getS3: () => Promise<S3Config | null> = async () => null,
  ) {
    mkdirSync(filesDir, { recursive: true })
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
    const c = await this.s3For()
    const rest = key.slice(S3_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash > 0) return { c, bucket: rest.slice(0, slash), objectKey: rest.slice(slash + 1) }
    return { c, bucket: c.bucket, objectKey: this.s3Key(c, rest) }
  }

  private async s3For(): Promise<S3Config> {
    const c = (await this.getS3()) ?? (await this.getConfig()).s3
    const err = validateS3Config(c)
    if (err || !c) throw new Error(`S3 storage is not configured: ${err}`)
    return c
  }

  private localPath(name: string) { return path.join(this.filesDir, path.basename(name)) }

  /** Stores a new file under a fresh name `<uuid>.<ext>` on the active backend. Returns the key to keep in the database. */
  async save(ext: string, body: Readable | Buffer | Uint8Array): Promise<string> {
    const name = `${randomUUID()}.${ext.replace(/^\./, '')}`
    const cfg = await this.getConfig()
    if (cfg.backend === 's3' && cfg.s3) return this.putS3(cfg.s3, name, body)
    const dest = this.localPath(name)
    if (body instanceof Readable) await pipeline(body, createWriteStream(dest))
    else await writeFile(dest, body)
    return name
  }

  private async putS3(c: S3Config, name: string, body: Readable | Buffer | Uint8Array): Promise<string> {
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
      await this.client(c).send(new PutObjectCommand({ Bucket: c.bucket, Key: this.s3Key(c, name), Body: buf, ContentLength: buf.length }))
    } finally { if (tmp) unlink(tmp).catch(() => {}) }
    return `${S3_PREFIX}${c.bucket}/${this.s3Key(c, name)}`
  }

  async exists(key: string): Promise<boolean> { return (await this.size(key)) !== null }

  /** Size in bytes, or null when the file is missing. */
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
    const p = this.localPath(key)
    return existsSync(p) ? createReadStream(p) : null
  }

  async read(key: string): Promise<Buffer | null> {
    const s = await this.open(key)
    if (!s) return null
    const chunks: Buffer[] = []
    for await (const c of s) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks)
  }

  /** Best effort: a file that is already gone is not an error. */
  async remove(key: string | null | undefined): Promise<void> {
    if (!key) return
    try {
      if (key.startsWith(S3_PREFIX)) {
        const { c, bucket, objectKey } = await this.locate(key)
        await this.client(c).send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
      } else await unlink(this.localPath(key))
    } catch { /* already gone or backend unreachable */ }
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
