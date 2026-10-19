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
CREATE INDEX IF NOT EXISTS markups_document ON markups(document_id) WHERE NOT deleted
`

export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await db.query(stmt)
  }
}
