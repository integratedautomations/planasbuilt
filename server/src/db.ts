import { mkdirSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

// Uses real Postgres when DATABASE_URL is set (production/Docker),
// otherwise an embedded PGlite database so dev needs no install.
export async function openDb(databaseUrl: string | undefined, dataDir: string | null): Promise<Db> {
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl })
    return {
      query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
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
  role text NOT NULL CHECK (role IN ('admin','editor','viewer')),
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

export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await db.query(stmt)
  }
  await seedSymbolSets(db)
}
