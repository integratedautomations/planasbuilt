import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb } from './db.js'
import type { Db } from './db.js'
import { buildApp } from './app.js'
import { STD_DEVICES, STD_SETS } from './standardLibraryData.js'
import { builtinBody, installLibrary, isStdIcon, matchStdDevice, planLibrary, previewLibrary, stdIconUrl } from './standardLibrary.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let admin = '', bob = ''
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const CUSTOM_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="red"/></svg>')
const OLD_BUILTIN = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>')

beforeAll(async () => {
  db = await openDb(undefined, null)
  await migrate(db)
  app = await buildApp({ db, jwtSecret: 'test', filesDir: mkdtempSync(path.join(tmpdir(), 'pm-std-')) })
  const setup = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'a@x.com', name: 'Ann Admin', password: 'password1', setupCode: 'test-setup-code' } })).json()
  admin = setup.token
  await app.inject({ method: 'POST', url: '/api/users', headers: H(admin), payload: { email: 'b@x.com', name: 'Bob', password: 'password1' } })
  bob = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'b@x.com', password: 'password1' } })).json().token
})

const counts = async () => ({
  sets: (await db.query('SELECT id FROM symbol_sets')).length,
  types: (await db.query('SELECT id FROM device_types')).length,
})
const snapshot = async () => JSON.stringify([
  await db.query('SELECT id, name, color, tag_prefix, icon, fields, has_fov, sort, archived FROM symbol_sets ORDER BY id'),
  await db.query('SELECT id, symbol_set_id, name, icon, tag_prefix, fields, coverage, mount, sort, archived FROM device_types ORDER BY id'),
])
const typeIn = async (set: string, name: string) => (await db.query(
  'SELECT t.* FROM device_types t JOIN symbol_sets s ON s.id = t.symbol_set_id WHERE lower(s.name) = lower($1) AND lower(t.name) = lower($2)', [set, name]))[0]

describe('standard library data', () => {
  it('has 10 sets and 145 devices that all carry a mount, a prefix and a recogniser', () => {
    expect(STD_SETS).toHaveLength(10)
    expect(STD_DEVICES).toHaveLength(145)
    for (const d of STD_DEVICES) {
      expect(['ceiling', 'wall', 'square']).toContain(d.mount)
      expect(d.tagPrefix).toMatch(/^[A-Z0-9]{1,6}$/)
      expect(new RegExp(d.match).test(d.name.toLowerCase()), d.name).toBe(true)
      expect(matchStdDevice(d.name, d.folder)?.slug, d.name).toBe(d.slug)
    }
  })
  it('defaults mounts by device kind', () => {
    const m = (s: string) => STD_DEVICES.find(d => d.slug === s)!.mount
    expect(['fire-smoke', 'fire-heat', 'network-wap', 'camera-dome', 'paging-speaker-ceiling', 'intrusion-motion'].map(m)).toEqual(Array(6).fill('ceiling'))
    expect(['access-reader', 'access-keypad', 'fire-pull', 'access-rex-button', 'fire-horn-strobe', 'intercom-door-audio', 'automation-thermostat'].map(m)).toEqual(Array(7).fill('wall'))
    expect(['fire-facp', 'access-controller', 'network-switch', 'network-rack', 'camera-nvr', 'access-power-supply'].map(m)).toEqual(Array(6).fill('square'))
  })
  it('gives cameras, motion sensors and speakers coverage', () => {
    const c = (s: string) => STD_DEVICES.find(d => d.slug === s)!.coverage
    for (const s of ['camera-dome', 'camera-ptz', 'intrusion-motion', 'paging-speaker-ceiling']) expect(c(s)).toMatchObject({ on: true })
    expect(c('fire-smoke')).toBeNull()
  })
  it('recognises built-in icons, in any colour, but not uploads', () => {
    const d = STD_DEVICES[0]
    expect(isStdIcon(stdIconUrl(d.icon))).toBe(true)
    expect(isStdIcon(stdIconUrl(d.iconB, '#ff0000'))).toBe(true)
    expect(isStdIcon(OLD_BUILTIN)).toBe(false)
    expect(builtinBody(OLD_BUILTIN)).not.toBeNull()
    expect(builtinBody(CUSTOM_SVG)).toBeNull()
    expect(builtinBody(PNG)).toBeNull()
    expect(builtinBody('')).toBeNull()
  })
})

describe('planLibrary (pure)', () => {
  it('creates every set and device on an empty database', () => {
    const p = planLibrary([], [])
    expect(p.setsToCreate).toHaveLength(10)
    expect(p.typesToAdd).toHaveLength(145)
    expect(p.typesToUpdate).toHaveLength(0)
  })
  it('matches an existing type by name (case-insensitive) and by the class matcher, and keeps custom and removed things alone', () => {
    const sets = [{ id: 's1', name: 'fire alarm', archived: false }, { id: 's2', name: 'Network', archived: true }]
    const t = (id: string, name: string, icon = '', extra = {}) => ({ id, symbol_set_id: 's1', name, icon, tag_prefix: null, coverage: null, mount: 'ceiling', archived: false, ...extra })
    const p = planLibrary(sets, [t('t1', 'SMOKE DETECTOR'), t('t2', 'Pull Station', CUSTOM_SVG), t('t3', 'Horn Strobe Combo', OLD_BUILTIN), t('t4', 'Heat Detector', '', { archived: true })])
    expect(p.setsToCreate.map(s => s.folder)).not.toContain('fire')
    expect(p.skippedSets).toEqual(['Network'])
    expect(p.skippedTypes).toEqual(['fire alarm / Heat Detector'])
    const up = (id: string) => p.typesToUpdate.find(u => u.id === id)!
    expect(up('t1').slug).toBe('fire-smoke')
    expect(up('t1').changes).toEqual(['icon', 'tag_prefix'])
    expect(up('t2').changes).toEqual(['mount', 'tag_prefix']) // custom icon untouched
    expect(up('t2').set.icon).toBeUndefined()
    expect(up('t3').slug).toBe('fire-horn-strobe')
    expect(up('t3').set.icon).toBe(stdIconUrl(STD_DEVICES.find(d => d.slug === 'fire-horn-strobe')!.icon))
    expect(p.customIconsKept).toBe(1)
    expect(p.typesToAdd.filter(a => a.folder === 'fire')).toHaveLength(28 - 4)
  })
  it('keeps option B and an existing prefix, mount and coverage', () => {
    const smoke = STD_DEVICES.find(d => d.slug === 'fire-smoke')!
    const p = planLibrary([{ id: 's1', name: 'Fire Alarm', archived: false }],
      [{ id: 't1', symbol_set_id: 's1', name: 'Smoke Detector', icon: stdIconUrl(smoke.iconB), tag_prefix: 'SM', coverage: { on: false, angle: 90, range_ft: 20 }, mount: 'square', archived: false }])
    expect(p.typesToUpdate.find(u => u.id === 't1')).toBeUndefined()
    expect(p.unchanged).toBe(1)
  })
})

describe('Standard device library route', () => {
  it('is for app admins only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/catalog/standard-library', headers: H(bob) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/catalog/standard-library', headers: H(bob) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/catalog/standard-library' })).statusCode).toBe(401)
  })

  it('previews, installs, and a second run changes nothing; custom icons survive; nothing is deleted', async () => {
    // Existing data: a custom-icon Card Reader, an old built-in icon on Smoke Detector, a user type outside the library
    const [ac] = await db.query<{ id: string }>("SELECT id FROM symbol_sets WHERE name = 'Access Control'")
    const [fa] = await db.query<{ id: string }>("SELECT id FROM symbol_sets WHERE name = 'Fire Alarm'")
    await db.query("DELETE FROM device_types WHERE symbol_set_id = ANY($1::uuid[])", [[ac.id, fa.id]])
    await db.query("INSERT INTO device_types (symbol_set_id, name, icon, sort) VALUES ($1,'card reader',$2,1)", [ac.id, PNG])
    await db.query("INSERT INTO device_types (symbol_set_id, name, icon, tag_prefix, sort) VALUES ($1,'Smoke Detector',$2,'SMK',1)", [fa.id, OLD_BUILTIN])
    await db.query("INSERT INTO device_types (symbol_set_id, name, icon, sort) VALUES ($1,'My Special Gadget','',2)", [fa.id])
    const before = await counts()

    const preview = (await app.inject({ method: 'GET', url: '/api/catalog/standard-library', headers: H(admin) })).json()
    expect(await counts()).toEqual(before) // the preview writes nothing
    expect(preview.setsCreated).toBe(6) // Cameras, Fire Alarm, Access Control and Network exist from the seed
    expect(preview.newSets).toEqual(expect.arrayContaining(['Intrusion', 'Intercom', 'Nurse Call', 'Paging / Audio', 'Automation', 'General']))
    expect(preview.typesUpdated).toBeGreaterThanOrEqual(2)
    expect(preview.customIconsKept).toBe(1)

    const run1 = (await app.inject({ method: 'POST', url: '/api/catalog/standard-library', headers: H(admin) })).json()
    expect(run1.setsCreated).toBe(preview.setsCreated)
    expect(run1.typesAdded).toBe(preview.typesAdded)
    expect(run1.typesUpdated).toBe(preview.typesUpdated)

    const after = await counts()
    expect(after.sets).toBe(before.sets + 6)
    expect(after.types).toBeGreaterThanOrEqual(before.types + 100)
    expect((await db.query('SELECT id FROM symbol_sets WHERE archived')).length).toBe(0)
    expect((await db.query('SELECT id FROM device_types WHERE archived')).length).toBe(0)

    // Every device now exists once in its set under the library's name, or under the name of the existing type that was matched to it
    for (const d of STD_DEVICES) {
      const set = STD_SETS.find(s => s.folder === d.folder)!
      const rows = await db.query(
        'SELECT t.id FROM device_types t JOIN symbol_sets s ON s.id = t.symbol_set_id WHERE lower(s.name) = lower($1) AND lower(t.name) = lower($2)', [set.name, d.name])
      expect(rows.length, d.name).toBeLessThanOrEqual(1)
      if (rows.length === 0) expect(['camera-bullet'], d.name).toContain(d.slug) // the seeded "IP Camera" is the bullet camera
    }

    const reader = await typeIn('Access Control', 'card reader')
    expect(reader.icon).toBe(PNG) // custom upload kept
    expect(reader.mount).toBe('wall') // blank default mount filled in
    expect(reader.tag_prefix).toBe('CR')
    expect((await db.query("SELECT id FROM device_types WHERE symbol_set_id = $1 AND lower(name) = 'card reader'", [ac.id])).length).toBe(1)

    const smoke = await typeIn('Fire Alarm', 'Smoke Detector')
    expect(smoke.icon).toBe(stdIconUrl(STD_DEVICES.find(d => d.slug === 'fire-smoke')!.icon)) // old built-in replaced by option A
    expect(smoke.tag_prefix).toBe('SMK') // kept
    expect(smoke.mount).toBe('ceiling')

    expect((await typeIn('Fire Alarm', 'My Special Gadget')).name).toBe('My Special Gadget')
    const cam = await typeIn('Cameras', 'Dome Camera')
    expect(cam.mount).toBe('ceiling')
    expect(cam.coverage).toMatchObject({ on: true })
    expect((await typeIn('Paging / Audio', 'Ceiling Speaker')).icon).toMatch(/^data:image\/svg\+xml/)

    // Second run: nothing to do and the database is byte for byte the same
    const snap = await snapshot()
    expect((await app.inject({ method: 'GET', url: '/api/catalog/standard-library', headers: H(admin) })).json()).toMatchObject({ setsCreated: 0, typesAdded: 0, typesUpdated: 0 })
    const run2 = (await app.inject({ method: 'POST', url: '/api/catalog/standard-library', headers: H(admin) })).json()
    expect(run2).toMatchObject({ setsCreated: 0, typesAdded: 0, typesUpdated: 0 })
    expect(await snapshot()).toBe(snap)
    expect(await previewLibrary(db)).toMatchObject({ setsCreated: 0, typesAdded: 0, typesUpdated: 0 })
    expect(await installLibrary(db)).toMatchObject({ setsCreated: 0, typesAdded: 0, typesUpdated: 0 })
  })

  it('does not bring back a symbol set or type that was archived, and still never deletes', async () => {
    await db.query("UPDATE symbol_sets SET archived = true WHERE name = 'General'")
    const [net] = await db.query<{ id: string }>("SELECT id FROM symbol_sets WHERE name = 'Network'")
    await db.query("UPDATE device_types SET archived = true WHERE symbol_set_id = $1 AND name = 'Patch Panel'", [net.id])
    const before = await counts()
    const r = (await app.inject({ method: 'POST', url: '/api/catalog/standard-library', headers: H(admin) })).json()
    expect(r).toMatchObject({ setsCreated: 0, typesAdded: 0, typesUpdated: 0, skippedSets: ['General'], skippedTypes: ['Network / Patch Panel'] })
    expect(await counts()).toEqual(before)
  })
})
