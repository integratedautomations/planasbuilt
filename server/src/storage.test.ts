import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Storage } from './storage.js'
import type { S3Config } from './storage.js'
import { fakeS3Client } from './testutil.js'

const dir = () => mkdtempSync(path.join(tmpdir(), 'pm-st-'))
const ctx = { kind: 'plan' as const, ext: 'pdf', company: 'Acme', project: 'HQ', plan: 'L1', rev: 1, at: new Date(Date.UTC(2026, 0, 2)), original: 'a.pdf' }
const text = async (s: Storage, key: string) => (await s.read(key))?.toString()

describe('local storage with readable paths', () => {
  it('saves under the layout path and reads it back; a taken name gets (2), compared without case', async () => {
    const root = dir(), s = new Storage(root)
    const k1 = await s.save(ctx, Buffer.from('one'))
    expect(k1).toBe('Acme/Projects/HQ/Plans/L1/Rev 01 - 2026-01-02 - a.pdf')
    const k2 = await s.save(ctx, Buffer.from('two'))
    expect(k2).toBe('Acme/Projects/HQ/Plans/L1/Rev 01 - 2026-01-02 - a (2).pdf')
    const k3 = await s.save({ ...ctx, original: 'A.PDF' }, Buffer.from('three')) // same name apart from case
    expect(k3).toBe('Acme/Projects/HQ/Plans/L1/Rev 01 - 2026-01-02 - A (3).pdf')
    expect([await text(s, k1), await text(s, k2), await text(s, k3)]).toEqual(['one', 'two', 'three'])
    expect(readFileSync(path.join(root, ...k1.split('/')), 'utf8')).toBe('one')
  })

  it('still saves and reads old flat <uuid>.<ext> keys', async () => {
    const root = dir(), s = new Storage(root)
    const k = await s.save('pdf', Buffer.from('flat'))
    expect(k).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(existsSync(path.join(root, k))).toBe(true)
    writeFileSync(path.join(root, 'legacy-name.png'), 'old')
    expect(await text(s, 'legacy-name.png')).toBe('old')
    expect(await s.size('legacy-name.png')).toBe(3)
  })

  it('refuses keys that would leave the files directory', async () => {
    const root = dir(), s = new Storage(root)
    writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'nope')
    for (const bad of ['../secret.txt', 'a/../../secret.txt', '/etc/passwd', 'C:/Windows/win.ini', 'a\\..\\b', 'x\0y']) {
      expect(await s.exists(bad), bad).toBe(false)
      expect(await s.open(bad), bad).toBeNull()
      expect(await s.read(bad), bad).toBeNull()
      await s.remove(bad)
      await expect(s.relocate(bad, 'safe/new.txt')).rejects.toThrow()
    }
    await expect(s.relocate('x.pdf', '../escape.pdf')).rejects.toThrow(/Invalid/)
    expect(existsSync(path.join(path.dirname(root), 'secret.txt'))).toBe(true)
  })

  it('relocate moves the file, runs the commit with the new key, and prunes empty folders', async () => {
    const root = dir(), s = new Storage(root)
    const k = await s.save(ctx, Buffer.from('pdf'))
    let seen = ''
    const moved = await s.relocate(k, 'Beta/Projects/HQ/Plans/L1/new name.pdf', async nk => { seen = nk })
    expect(moved).toBe('Beta/Projects/HQ/Plans/L1/new name.pdf')
    expect(seen).toBe(moved)
    expect(await text(s, moved)).toBe('pdf')
    expect(await s.exists(k)).toBe(false)
    expect(readdirSync(root)).toEqual(['Beta']) // the old Acme tree is gone
    // moving to where it already is changes nothing
    expect(await s.relocate(moved, moved)).toBe(moved)
  })

  it('relocate keeps the original and removes the copy when the commit fails', async () => {
    const root = dir(), s = new Storage(root)
    const k = await s.save(ctx, Buffer.from('keep'))
    await expect(s.relocate(k, 'Other/x.pdf', async () => { throw new Error('db down') })).rejects.toThrow('db down')
    expect(await text(s, k)).toBe('keep')
    expect(existsSync(path.join(root, 'Other', 'x.pdf'))).toBe(false)
    await expect(s.relocate('missing.pdf', 'Other/y.pdf')).rejects.toThrow(/missing/i)
  })

  it('relocate onto a taken name picks (2) instead of overwriting', async () => {
    const root = dir(), s = new Storage(root)
    const a = await s.save(ctx, Buffer.from('A')), b = await s.save({ ...ctx, original: 'b.pdf' }, Buffer.from('B'))
    const moved = await s.relocate(b, a)
    expect(moved).toBe(a.replace('.pdf', ' (2).pdf'))
    expect(await text(s, a)).toBe('A')
    expect(await text(s, moved)).toBe('B')
  })

  it('renames in place when only the case of a folder changes', async () => {
    const root = dir(), s = new Storage(root)
    const k = await s.save({ ...ctx, company: 'acme' }, Buffer.from('c'))
    const moved = await s.relocate(k, k.replace('acme', 'Acme'))
    expect(await text(s, moved)).toBe('c')
    expect(readdirSync(root).map(n => n.toLowerCase())).toEqual(['acme'])
    expect(path.basename(moved)).toBe(path.basename(k))
  })
})

describe('trash', () => {
  it('moves a removed file to _trash/<stamp>/<same path> and purges it after the retention period', async () => {
    const root = dir(), s = new Storage(root, undefined, undefined, undefined, async () => 30)
    const k = await s.save(ctx, Buffer.from('bye'))
    await s.remove(k)
    expect(await s.exists(k)).toBe(false)
    const [stamp] = readdirSync(path.join(root, '_trash'))
    expect(stamp).toMatch(/^\d{8}-\d{6}$/)
    expect(readFileSync(path.join(root, '_trash', stamp, ...k.split('/')), 'utf8')).toBe('bye')
    expect(readdirSync(root).sort()).toEqual(['_trash']) // the emptied company folders are gone
    // a legacy flat key is trashed too
    const flat = await s.save('png', Buffer.from('flat'))
    await s.remove(flat)
    expect(existsSync(path.join(root, flat))).toBe(false)

    expect(await s.purgeTrash(30)).toBe(0) // too young
    expect(await s.purgeTrash(30, Date.now() + 31 * 86_400_000)).toBeGreaterThan(0)
    expect(existsSync(path.join(root, '_trash', stamp))).toBe(false)
  })

  it('deletes at once with hard, or when the retention is 0 days', async () => {
    const root = dir()
    const s = new Storage(root, undefined, undefined, undefined, async () => 30)
    const k = await s.save(ctx, Buffer.from('x'))
    await s.remove(k, { hard: true })
    expect(existsSync(path.join(root, '_trash'))).toBe(false)
    const zero = new Storage(dir())
    const k2 = await zero.save(ctx, Buffer.from('y'))
    await zero.remove(k2)
    expect(await zero.exists(k2)).toBe(false)
    expect(existsSync(path.join(zero.filesDir, '_trash'))).toBe(false)
    await zero.remove('never-existed.pdf') // best effort
  })
})

describe('s3 storage', () => {
  const objects = new Map<string, Buffer>()
  const cfg: S3Config = { endpoint: 'https://s3.example.com', bucket: 'bkt', region: 'auto', accessKeyId: 'AK', secret: 'SK', pathStyle: false, prefix: 'pre' }
  const make = () => new Storage(dir(), async () => ({ backend: 's3', s3: cfg }), () => fakeS3Client(objects), async () => [cfg], async () => 7)

  it('saves under the prefix with the layout path and keeps names unique', async () => {
    const s = make()
    const k1 = await s.save(ctx, Buffer.from('s1'))
    expect(k1).toBe('s3:bkt/pre/Acme/Projects/HQ/Plans/L1/Rev 01 - 2026-01-02 - a.pdf')
    const k2 = await s.save(ctx, Buffer.from('s2'))
    expect(k2).toBe('s3:bkt/pre/Acme/Projects/HQ/Plans/L1/Rev 01 - 2026-01-02 - a (2).pdf')
    expect(await s.pathOf(k1)).toBe('Acme/Projects/HQ/Plans/L1/Rev 01 - 2026-01-02 - a.pdf')
    expect(await text(s, k2)).toBe('s2')
    // a legacy key (the old flat layout) still reads
    objects.set('bkt/pre/0f8fad5b-d9cb-469f-a165-70867728950e.pdf', Buffer.from('legacy'))
    expect(await text(s, 's3:bkt/pre/0f8fad5b-d9cb-469f-a165-70867728950e.pdf')).toBe('legacy')
  })

  it('relocate copies, commits, then deletes; a failed commit leaves the original', async () => {
    const s = make()
    const k = await s.save({ ...ctx, plan: 'move me' }, Buffer.from('mv'))
    await expect(s.relocate(k, 'Beta/x.pdf', async () => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(objects.has('bkt/pre/Beta/x.pdf')).toBe(false)
    expect(await s.exists(k)).toBe(true)
    let committed = ''
    const nk = await s.relocate(k, 'Beta/with space/ünï.pdf', async n => { committed = n })
    expect(nk).toBe('s3:bkt/pre/Beta/with space/ünï.pdf')
    expect(committed).toBe(nk)
    expect(await s.exists(k)).toBe(false)
    expect(await text(s, nk)).toBe('mv')
  })

  it('remove moves to _trash/<stamp>/ and purge deletes old batches', async () => {
    const s = make()
    const k = await s.save({ ...ctx, plan: 'trash me' }, Buffer.from('t'))
    await s.remove(k)
    expect(await s.exists(k)).toBe(false)
    const trashed = [...objects.keys()].filter(x => x.startsWith('bkt/pre/_trash/') && x.endsWith('Rev 01 - 2026-01-02 - a.pdf') && x.includes('trash me'))
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(/^bkt\/pre\/_trash\/\d{8}-\d{6}\/Acme\/Projects\/HQ\/Plans\/trash me\//)
    expect(await s.purgeTrash(7)).toBe(0)
    expect(await s.purgeTrash(7, Date.now() + 8 * 86_400_000)).toBeGreaterThan(0)
    expect([...objects.keys()].some(x => x.includes('/_trash/') && x.includes('trash me'))).toBe(false)
    s.remove(k, { hard: true })
  })
})
