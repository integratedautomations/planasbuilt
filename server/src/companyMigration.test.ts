// The move from one organization per install to companies: existing data lands in a default company, in one
// transaction, and running the migration again changes nothing.
import { describe, expect, it } from 'vitest'
import { SCHEMA, migrate, openDb } from './db.js'
import type { Db } from './db.js'

/** A database as the previous version left it: the old schema (no company_id anywhere) filled with data. */
async function legacyDb(opts: { orgName?: string } = {}) {
  const db = await openDb(undefined, null)
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt)
  const user = async (email: string, isAdmin: boolean, canCreate = false, status = 'active') =>
    (await db.query<{ id: string }>(
      'INSERT INTO users (email, name, password_hash, is_admin, can_create_projects, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, email.split('@')[0], 'x', isAdmin, canCreate, status]))[0].id
  const boss = await user('boss@x.com', true)
  const maker = await user('maker@x.com', false, true)
  const plain = await user('plain@x.com', false)
  const pending = await user('pending@x.com', false, false, 'invited')
  const [set] = await db.query<{ id: string }>("INSERT INTO symbol_sets (name, color, tag_prefix) VALUES ('Cameras','#1971c2','CAM') RETURNING id")
  const [type] = await db.query<{ id: string }>("INSERT INTO device_types (symbol_set_id, name) VALUES ($1,'Dome') RETURNING id", [set.id])
  const [prod] = await db.query<{ id: string }>("INSERT INTO products (device_type_id, manufacturer, model, unit_cost) VALUES ($1,'Axis','M1',99) RETURNING id", [type.id])
  await db.query("INSERT INTO cable_types (name) VALUES ('Cat6')")
  await db.query("INSERT INTO revu_mappings (signature, symbol_set_id, device_type_id, product_id) VALUES ('sig',$1,$2,$3)", [set.id, type.id, prod.id])
  const [project] = await db.query<{ id: string }>("INSERT INTO projects (name, created_by) VALUES ('Old job',$1) RETURNING id", [boss])
  await db.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'admin'), ($1,$3,'editor')", [project.id, boss, plain])
  if (opts.orgName) await db.query("INSERT INTO settings (key, value) VALUES ('company', $1)", [JSON.stringify({ name: opts.orgName, phone: '555' })])
  await db.query("INSERT INTO settings (key, value) VALUES ('tags', '{\"padding\":3}'), ('backups', '{\"targets\":[]}')")
  await db.query("INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'invite','h1', now() + interval '1 day'), ($1,'reset','h2', now() + interval '1 day')", [pending])
  await db.query("INSERT INTO user_prefs (user_id, prefs) VALUES ($1, '{\"a\":1}')", [boss])
  return { db, ids: { boss, maker, plain, pending, set: set.id, type: type.id, prod: prod.id, project: project.id } }
}

const one = async <T = any>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0]

describe('migration to companies', () => {
  it('moves an existing install into one default company named after the organization', async () => {
    const { db, ids } = await legacyDb({ orgName: 'Acme Security' })
    await migrate(db)
    const companies = await db.query<any>('SELECT id, name, slug, archived FROM companies')
    expect(companies).toHaveLength(1)
    expect(companies[0]).toMatchObject({ name: 'Acme Security', slug: 'acme-security', archived: false })
    const c = companies[0].id
    // every row was assigned
    for (const t of ['projects', 'symbol_sets', 'device_types', 'products', 'cable_types', 'revu_mappings', 'settings'])
      expect((await one(db, `SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`, [c])).n, t).toBe(
        (await one(db, `SELECT count(*)::int AS n FROM ${t}`)).n)
    expect((await one(db, 'SELECT count(*)::int AS n FROM projects')).n).toBe(1)
    expect((await one(db, 'SELECT count(*)::int AS n FROM products')).n).toBe(1) // nothing was seeded over existing data
    // everyone is a member; app admins became owners and stay platform admins
    const members = Object.fromEntries((await db.query<any>(
      'SELECT u.email, m.role, m.can_create_projects AS can FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1', [c])).map(r => [r.email, r]))
    expect(Object.keys(members).sort()).toEqual(['boss@x.com', 'maker@x.com', 'pending@x.com', 'plain@x.com'])
    expect(members['boss@x.com']).toMatchObject({ role: 'owner', can: true })
    expect(members['maker@x.com']).toMatchObject({ role: 'member', can: true })
    expect(members['plain@x.com']).toMatchObject({ role: 'member', can: false })
    expect((await one(db, 'SELECT is_admin FROM users WHERE id = $1', [ids.boss])).is_admin).toBe(true)
    // settings kept their values, keyed by company now; the old branding row survived
    expect((await one(db, "SELECT value FROM settings WHERE company_id = $1 AND key = 'tags'", [c])).value).toEqual({ padding: 3 })
    expect((await one(db, "SELECT value FROM settings WHERE company_id = $1 AND key = 'company'", [c])).value).toMatchObject({ name: 'Acme Security', phone: '555' })
    expect((await one(db, "SELECT value FROM settings WHERE company_id = $1 AND key = 'backups'", [c])).value).toEqual({ targets: [] })
    // pending invites belong to the company; reset tokens to none; prefs untouched
    expect((await one(db, "SELECT company_id FROM user_tokens WHERE purpose = 'invite'")).company_id).toBe(c)
    expect((await one(db, "SELECT company_id FROM user_tokens WHERE purpose = 'reset'")).company_id).toBeNull()
    expect((await one(db, 'SELECT prefs, last_company_id FROM user_prefs WHERE user_id = $1', [ids.boss]))).toMatchObject({ prefs: { a: 1 }, last_company_id: null })
    // other companies can now hold the same keys and signatures
    const [other] = await db.query<{ id: string }>("INSERT INTO companies (name, slug) VALUES ('B','b') RETURNING id")
    await db.query("INSERT INTO settings (company_id, key, value) VALUES ($1,'tags','{\"padding\":2}')", [other.id])
    await db.query("INSERT INTO revu_mappings (company_id, signature, action) VALUES ($1,'sig','skip')", [other.id])
    await expect(db.query("INSERT INTO settings (company_id, key, value) VALUES ($1,'tags','{}')", [other.id])).rejects.toThrow()
    // the company columns are mandatory
    await expect(db.query("INSERT INTO projects (name) VALUES ('no company')")).rejects.toThrow()
    await expect(db.query("INSERT INTO symbol_sets (name, color, tag_prefix) VALUES ('x','#000000','X')")).rejects.toThrow()
  })

  it('is idempotent: a second run changes nothing, and removed members stay removed', async () => {
    const { db, ids } = await legacyDb({ orgName: 'Acme Security' })
    await migrate(db)
    const c = (await one(db, 'SELECT id FROM companies')).id
    await db.query('DELETE FROM company_members WHERE user_id = $1', [ids.plain])
    await db.query("UPDATE company_members SET role = 'admin' WHERE user_id = $1", [ids.maker])
    await db.query("UPDATE settings SET value = '{\"padding\":4}' WHERE company_id = $1 AND key = 'tags'", [c])
    const snap = async () => JSON.stringify(await Promise.all(
      ['companies', 'company_members', 'settings', 'projects', 'symbol_sets', 'device_types', 'products', 'cable_types', 'revu_mappings']
        .map(t => db.query(`SELECT * FROM ${t} ORDER BY 1, 2`))))
    const before = await snap()
    await migrate(db)
    await migrate(db)
    expect(await snap()).toBe(before)
    expect((await one(db, 'SELECT count(*)::int AS n FROM companies')).n).toBe(1)
    expect((await one(db, 'SELECT count(*)::int AS n FROM company_members WHERE user_id = $1', [ids.plain])).n).toBe(0)
  })

  it('names the company "My Company" when the organization had no name', async () => {
    const { db } = await legacyDb()
    await migrate(db)
    expect((await one(db, 'SELECT name, slug FROM companies'))).toMatchObject({ name: 'My Company', slug: 'my-company' })
    expect((await one(db, "SELECT value FROM settings WHERE key = 'company'")).value).toMatchObject({ name: 'My Company' })
  })

  it('is all or nothing: a failure part-way leaves the old database exactly as it was', async () => {
    const { db } = await legacyDb({ orgName: 'Acme Security' })
    // A table of the wrong shape under one of the new names makes the migration fail after it created the companies table.
    await db.query('CREATE TABLE company_members (nothing int)')
    await expect(migrate(db)).rejects.toThrow()
    expect((await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'companies'")).length).toBe(0)
    expect((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'settings' AND column_name = 'company_id'")).length).toBe(0)
    expect((await one(db, 'SELECT count(*)::int AS n FROM settings')).n).toBe(3)
    // fixing the problem and migrating again succeeds
    await db.query('DROP TABLE company_members')
    await migrate(db)
    expect((await one(db, 'SELECT count(*)::int AS n FROM companies')).n).toBe(1)
    expect((await one(db, 'SELECT count(*)::int AS n FROM company_members')).n).toBe(4)
  })

  it('a fresh install gets one empty "My Company" holding the starter catalog', async () => {
    const db = await openDb(undefined, null)
    await migrate(db)
    const c = await db.query<any>('SELECT id, name FROM companies')
    expect(c).toHaveLength(1)
    expect(c[0].name).toBe('My Company')
    expect((await one(db, 'SELECT count(*)::int AS n FROM company_members')).n).toBe(0)
    expect((await one(db, 'SELECT count(*)::int AS n FROM symbol_sets WHERE company_id = $1', [c[0].id])).n).toBeGreaterThan(0)
    expect((await one(db, 'SELECT count(*)::int AS n FROM device_types WHERE company_id = $1', [c[0].id])).n).toBeGreaterThan(0)
    expect((await one(db, 'SELECT count(*)::int AS n FROM products WHERE company_id = $1', [c[0].id])).n).toBeGreaterThan(0)
    await migrate(db) // and re-running does not seed twice
    expect((await one(db, 'SELECT count(*)::int AS n FROM symbol_sets')).n).toBe(4)
  })
})
