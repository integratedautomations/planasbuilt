import { mkdirSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>
  /** Runs `fn` in one transaction; `q` runs queries inside it. Rolls back if `fn` throws. */
  transaction<T>(fn: (q: Db['query']) => Promise<T>): Promise<T>
  close(): Promise<void>
}

// Uses real Postgres when DATABASE_URL is set (production/Docker),
// otherwise an embedded PGlite database so dev needs no install.
export async function openDb(databaseUrl: string | undefined, dataDir: string | null): Promise<Db> {
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl })
    return {
      query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
      transaction: async fn => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const out = await fn(async (sql, params) => (await client.query(sql, params as any[])).rows)
          await client.query('COMMIT')
          return out
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw e
        } finally { client.release() }
      },
      close: () => pool.end(),
    }
  }
  let lite: PGlite
  if (dataDir) {
    const dir = path.join(dataDir, 'pglite')
    mkdirSync(dir, { recursive: true })
    lite = new PGlite(dir)
  } else {
    lite = new PGlite() // in-memory, used by tests
  }
  return {
    query: async (sql, params) => (await lite.query<any>(sql, params as any[])).rows,
    transaction: fn => lite.transaction(tx => fn(async (sql, params) => (await tx.query<any>(sql, params as any[])).rows)),
    close: () => lite.close(),
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  revision int NOT NULL,
  file_key text NOT NULL,
  page_count int NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision)
);
CREATE TABLE IF NOT EXISTS pages (
  revision_id uuid REFERENCES document_revisions(id) ON DELETE CASCADE,
  page_number int NOT NULL,
  scale_ratio double precision,
  PRIMARY KEY (revision_id, page_number)
);
CREATE TABLE IF NOT EXISTS layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#e8590c',
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS markups (
  id uuid PRIMARY KEY,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  page int NOT NULL,
  type text NOT NULL,
  geometry jsonb NOT NULL,
  style jsonb NOT NULL DEFAULT '{}',
  text text NOT NULL DEFAULT '',
  layer_id uuid REFERENCES layers(id) ON DELETE SET NULL,
  version int NOT NULL DEFAULT 1,
  deleted boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS markups_document ON markups(document_id) WHERE NOT deleted;
CREATE TABLE IF NOT EXISTS symbol_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text NOT NULL,
  tag_prefix text NOT NULL,
  icon text NOT NULL DEFAULT '',
  fields jsonb NOT NULL DEFAULT '[]',
  has_fov boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE markups ADD COLUMN IF NOT EXISTS symbol_set_id uuid REFERENCES symbol_sets(id) ON DELETE SET NULL;
ALTER TABLE markups ADD COLUMN IF NOT EXISTS tag text NOT NULL DEFAULT '';
ALTER TABLE markups ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT '';
ALTER TABLE markups ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY,
  markup_id uuid REFERENCES markups(id) ON DELETE CASCADE,
  file_key text NOT NULL,
  annotated_key text,
  caption text NOT NULL DEFAULT '',
  width int,
  height int,
  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_markup ON attachments(markup_id);
CREATE TABLE IF NOT EXISTS page_scales (
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  page int NOT NULL,
  points_per_foot double precision NOT NULL,
  label text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (document_id, page)
);
CREATE TABLE IF NOT EXISTS markup_events (
  id bigserial PRIMARY KEY,
  markup_id uuid REFERENCES markups(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  at timestamptz DEFAULT now(),
  action text NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS markup_events_markup ON markup_events(markup_id, at);
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS device_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol_set_id uuid NOT NULL REFERENCES symbol_sets(id) ON DELETE CASCADE,
  name text NOT NULL,
  icon text NOT NULL DEFAULT '',
  tag_prefix text,
  fields jsonb NOT NULL DEFAULT '[]',
  default_product_id uuid,
  sort int NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type_id uuid REFERENCES device_types(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'device',
  manufacturer text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  spec_url text NOT NULL DEFAULT '',
  unit_cost numeric NOT NULL DEFAULT 0,
  labor_hours numeric NOT NULL DEFAULT 0,
  default_fields jsonb NOT NULL DEFAULT '{}',
  accessories jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS revu_mappings (
  signature text PRIMARY KEY,
  symbol_set_id uuid REFERENCES symbol_sets(id) ON DELETE SET NULL,
  device_type_id uuid REFERENCES device_types(id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  action text NOT NULL DEFAULT 'device' CHECK (action IN ('device','plain','skip')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE device_types ADD COLUMN IF NOT EXISTS coverage jsonb;
-- How devices of this type are mounted: a circle (ceiling), a D whose flat side is the wall (wall), or a rounded square (square)
ALTER TABLE device_types ADD COLUMN IF NOT EXISTS mount text NOT NULL DEFAULT 'ceiling';
ALTER TABLE markups ADD COLUMN IF NOT EXISTS device_type_id uuid REFERENCES device_types(id) ON DELETE SET NULL;
ALTER TABLE markups ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;
-- The version at which a delete or a page operation (page delete/move/rotate, revision restore) last changed the
-- markup's existence, page or geometry. A queued offline edit based on an older version must not overwrite that.
ALTER TABLE markups ADD COLUMN IF NOT EXISTS struct_version int NOT NULL DEFAULT 0;
UPDATE markups SET struct_version = version WHERE deleted AND struct_version = 0;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'upload';
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS markups_snapshot jsonb;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS attachments_snapshot jsonb;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS scales_snapshot jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_version int NOT NULL DEFAULT 0;
-- Who may create projects (app admins always can). Off by default: a project's creator becomes its admin and can invite people and upload files.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_create_projects boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS completed_at timestamptz;
-- Project roles: admin, pm, editor, field, sub, client, viewer (server/src/roles.ts). The old 3-role CHECK is replaced.
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_chk;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_chk CHECK (role IN ('admin','pm','editor','field','sub','client','viewer'));
-- What a sub may see and work on: {"sets": [symbol set ids], "layers": [layer ids]}. Empty = nothing.
ALTER TABLE project_members ADD COLUMN IF NOT EXISTS scope jsonb NOT NULL DEFAULT '{"sets":[],"layers":[]}';
-- Whether editors may see unit costs and labor hours in this project (pm and admin always can). On = behaviour before roles existed.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS editors_see_costs boolean NOT NULL DEFAULT true;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS device_scale double precision NOT NULL DEFAULT 1;
-- Cable types (Cat6, 18/2, fiber...): a shared catalog list, cables on a plan pick one by id (markups.fields.cable_type).
CREATE TABLE IF NOT EXISTS cable_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#e03131',
  sort int NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Project cable defaults: slack added to every drawn run (percent) and the drop length added at each end linked to a device (feet).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cable_slack_pct double precision NOT NULL DEFAULT 10;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cable_drop_ft double precision NOT NULL DEFAULT 0;
-- Project settings (Phase 8c): statuses, required fields, tag rules, report sections, photo quality, lock. See projectSettings.ts.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS user_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('invite','reset')),
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)
`

const svg = (body: string) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)

/** Starter symbol sets so a new install is useful right away; admins edit them in the app. */
const DEFAULT_SETS = [
  {
    name: 'Cameras', color: '#1971c2', tag_prefix: 'CAM', has_fov: true,
    icon: svg('<path d="M3 8h12v8H3z"/><path d="M15 11l6-3v8l-6-3"/>'),
    fields: [
      { key: 'ip', label: 'IP address', type: 'ip' },
      { key: 'mac', label: 'MAC address', type: 'text' },
      { key: 'nvr', label: 'NVR', type: 'text' },
      { key: 'channel', label: 'NVR channel', type: 'number' },
      { key: 'lens', label: 'Lens / type', type: 'select', options: ['Fixed dome', 'Varifocal dome', 'Bullet', 'PTZ', '360° fisheye', 'Multi-sensor'] },
    ],
  },
  {
    name: 'Fire Alarm', color: '#e03131', tag_prefix: 'FA', has_fov: false,
    icon: svg('<path d="M12 3c3 4 6 6 6 10a6 6 0 01-12 0c0-2 1-4 3-5 0 2 1 3 2 3 0-3 0-5 1-8z"/>'),
    fields: [
      { key: 'device_type', label: 'Device type', type: 'select', options: ['Smoke', 'Heat', 'Pull station', 'Horn/strobe', 'Strobe', 'Duct detector', 'Monitor module', 'Control module'] },
      { key: 'panel', label: 'Fire panel', type: 'text' },
      { key: 'loop', label: 'Loop / SLC', type: 'text' },
      { key: 'address', label: 'Address', type: 'text' },
      { key: 'zone', label: 'Zone', type: 'text' },
    ],
  },
  {
    name: 'Access Control', color: '#2f9e44', tag_prefix: 'AC', has_fov: false,
    icon: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M9 17h6"/>'),
    fields: [
      { key: 'door', label: 'Door number', type: 'text' },
      { key: 'panel', label: 'Controller / panel', type: 'text' },
      { key: 'reader', label: 'Reader type', type: 'text' },
      { key: 'lock', label: 'Lock hardware', type: 'select', options: ['Mag lock', 'Electric strike', 'Electrified lever', 'Exit device', 'None'] },
      { key: 'rex', label: 'REX', type: 'checkbox' },
      { key: 'ip', label: 'IP address', type: 'ip' },
    ],
  },
  {
    name: 'Network', color: '#7048e8', tag_prefix: 'WAP', has_fov: false,
    icon: svg('<path d="M5 12a10 10 0 0114 0"/><path d="M8 15a6 6 0 018 0"/><circle cx="12" cy="18" r="1"/>'),
    fields: [
      { key: 'ip', label: 'IP address', type: 'ip' },
      { key: 'mac', label: 'MAC address', type: 'text' },
      { key: 'vlan', label: 'VLAN', type: 'number' },
      { key: 'switch', label: 'Switch', type: 'text' },
      { key: 'port', label: 'Switch port', type: 'text' },
    ],
  },
]

async function seedSymbolSets(db: Db) {
  const [{ count }] = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM symbol_sets')
  if (count > 0) return
  let sort = 0
  for (const s of DEFAULT_SETS) {
    await db.query(
      'INSERT INTO symbol_sets (name, color, tag_prefix, icon, fields, has_fov, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [s.name, s.color, s.tag_prefix, s.icon, JSON.stringify(s.fields), s.has_fov, sort++])
  }
}

type SeedProduct = { manufacturer: string; model: string; name: string; unit_cost: number; labor_hours: number; default_fields?: Record<string, any>; accessories?: { model: string; qty: number }[] }
type SeedType = { name: string; tag_prefix?: string; products: SeedProduct[] }
const SEED_CATALOG: Record<string, SeedType[]> = {
  Cameras: [
    { name: 'IP Camera', products: [
      { manufacturer: 'Hikvision', model: 'DS-2CD2387G2-LSU/SL', name: 'Outdoor 8MP ColorVu Bullet', unit_cost: 289, labor_hours: 1.5, default_fields: { lens: 'Bullet' }, accessories: [{ model: 'DS-1280ZJ-S', qty: 1 }] },
      { manufacturer: 'Axis', model: 'M3216-LVE', name: 'Indoor/Outdoor 4MP Dome', unit_cost: 549, labor_hours: 1.5, default_fields: { lens: 'Fixed dome' } },
    ] },
    { name: 'PTZ Camera', tag_prefix: 'PTZ', products: [
      { manufacturer: 'Axis', model: 'Q6225-LE', name: '2MP 30x PTZ', unit_cost: 2800, labor_hours: 3, default_fields: { lens: 'PTZ' } },
    ] },
  ],
  'Fire Alarm': [
    { name: 'Smoke Detector', tag_prefix: 'SD', products: [{ manufacturer: 'Potter', model: 'PAD100-PHOTO', name: 'Photoelectric smoke detector', unit_cost: 62, labor_hours: 0.5, default_fields: { device_type: 'Smoke' }, accessories: [{ model: 'PAD100-B6', qty: 1 }] }] },
    { name: 'Heat Detector', tag_prefix: 'HD', products: [{ manufacturer: 'Potter', model: 'PAD100-HEAT', name: 'Heat detector', unit_cost: 55, labor_hours: 0.5, default_fields: { device_type: 'Heat' } }] },
    { name: 'Pull Station', tag_prefix: 'PS', products: [{ manufacturer: 'Potter', model: 'PAD100-PULL', name: 'Addressable pull station', unit_cost: 68, labor_hours: 0.75, default_fields: { device_type: 'Pull station' } }] },
    { name: 'Horn/Strobe', tag_prefix: 'HS', products: [{ manufacturer: 'Potter', model: 'PH-HS-W', name: 'Horn/strobe, wall, white', unit_cost: 74, labor_hours: 0.75, default_fields: { device_type: 'Horn/strobe' } }] },
    { name: 'Module', tag_prefix: 'MM', products: [{ manufacturer: 'Potter', model: 'PAD100-SM', name: 'Monitor module', unit_cost: 58, labor_hours: 0.75, default_fields: { device_type: 'Monitor module' } }] },
  ],
  'Access Control': [
    { name: 'Card Reader', tag_prefix: 'CR', products: [{ manufacturer: 'HID', model: 'RP40', name: 'Multi-tech reader', unit_cost: 195, labor_hours: 1, default_fields: { reader: 'Multi-tech' } }] },
    { name: 'Door Contact', tag_prefix: 'DC', products: [{ manufacturer: 'Sentrol', model: '1078W', name: 'Recessed door contact', unit_cost: 12, labor_hours: 0.5 }] },
    { name: 'REX', tag_prefix: 'REX', products: [{ manufacturer: 'Bosch', model: 'DS160', name: 'REX motion sensor', unit_cost: 48, labor_hours: 0.75, default_fields: { rex: true } }] },
  ],
  Network: [
    { name: 'Wireless Access Point', products: [{ manufacturer: 'Ubiquiti', model: 'U6-Pro', name: 'WiFi 6 Pro AP', unit_cost: 159, labor_hours: 1, accessories: [{ model: 'U-PoE-AF', qty: 1 }] }] },
  ],
}

async function seedCatalog(db: Db) {
  const [{ count }] = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM device_types')
  if (count > 0) return
  for (const [setName, types] of Object.entries(SEED_CATALOG)) {
    const [set] = await db.query('SELECT id FROM symbol_sets WHERE name = $1 LIMIT 1', [setName])
    if (!set) continue
    let sort = 0
    for (const t of types) {
      const [dt] = await db.query(
        'INSERT INTO device_types (symbol_set_id, name, tag_prefix, sort) VALUES ($1,$2,$3,$4) RETURNING id',
        [set.id, t.name, t.tag_prefix ?? null, sort++])
      let first: string | null = null
      for (const p of t.products) {
        const [pr] = await db.query(
          `INSERT INTO products (device_type_id, manufacturer, model, name, unit_cost, labor_hours, default_fields)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [dt.id, p.manufacturer, p.model, p.name, p.unit_cost, p.labor_hours, JSON.stringify(p.default_fields ?? {})])
        first ??= pr.id
        // Accessories are standalone accessory products referenced by id
        const acc: any[] = []
        for (const a of p.accessories ?? []) {
          const [ap] = await db.query(
            `INSERT INTO products (device_type_id, kind, manufacturer, model, name, unit_cost, labor_hours)
             VALUES (NULL,'accessory',$1,$2,$3,$4,$5) RETURNING id`,
            [p.manufacturer, a.model, a.model, 8, 0.25])
          acc.push({ product_id: ap.id, qty: a.qty })
        }
        if (acc.length) await db.query('UPDATE products SET accessories = $1 WHERE id = $2', [JSON.stringify(acc), pr.id])
      }
      await db.query('UPDATE device_types SET default_product_id = $1 WHERE id = $2', [first, dt.id])
    }
  }
}

export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await db.query(stmt)
  }
  await seedSymbolSets(db)
  await seedCatalog(db)
}
