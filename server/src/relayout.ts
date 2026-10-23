// Keeps files where their names say they should be.
//
// collectFiles() lists every stored file with the names that decide its readable path (company, project, plan, device tag...),
// planMoves() compares each file's current path with the path fileLayout.ts would build now, and a small in-process worker
// (class Relayout) works through persistent jobs (relayout_jobs) in batches. Database triggers queue a 'relayout' job whenever
// such a name changes (see RELAYOUT_TRIGGERS in db.ts); the admin's "Organize files" queues an 'organize' job, which also
// gives the old flat `<uuid>.<ext>` files a readable place. Everything is recomputed from the database on every batch, so a
// job can be interrupted, retried or run twice without harm.
import type { Db } from './db.js'
import type { Storage } from './storage.js'
import { buildPath, isLegacyName, samePlace } from './fileLayout.js'
import type { FileCtx } from './fileLayout.js'

type Q = Db['query']

export type Scope =
  | { type: 'all' }
  | { type: 'company' | 'project' | 'document' | 'markup' | 'attachment'; id: string }

export interface FileEntry {
  key: string
  ctx: FileCtx
  companyId: string | null
  projectId: string | null
  /** Where else the key is written down besides the plain columns. */
  holder: 'plan' | 'photo' | 'company-logo' | 'project-logo' | 'avatar'
  /** Revisions whose frozen photo list (attachments_snapshot) names this key. */
  snapshotRevs: string[]
}

export interface Move { key: string; from: string; to: string; entry: FileEntry }

const extOf = (key: string) => key.slice(key.lastIndexOf('.') + 1)

const WHERE: Record<string, string> = {
  company: 'p.company_id = $1::uuid', project: 'p.id = $1::uuid', document: 'd.id = $1::uuid', markup: 'm.id = $1::uuid', attachment: 'a.id = $1::uuid',
}

async function scopeCompany(q: Q, scope: Scope): Promise<string | null> {
  if (scope.type === 'all') return null
  if (scope.type === 'company') return scope.id
  const sql: Record<string, string> = {
    project: 'SELECT company_id AS c FROM projects WHERE id = $1',
    document: 'SELECT p.company_id AS c FROM documents d JOIN projects p ON p.id = d.project_id WHERE d.id = $1',
    markup: 'SELECT p.company_id AS c FROM markups m JOIN documents d ON d.id = m.document_id JOIN projects p ON p.id = d.project_id WHERE m.id = $1',
    attachment: 'SELECT p.company_id AS c FROM attachments a JOIN markups m ON m.id = a.markup_id JOIN documents d ON d.id = m.document_id JOIN projects p ON p.id = d.project_id WHERE a.id = $1',
  }
  return (await q<{ c: string }>(sql[scope.type], [scope.id]))[0]?.c ?? null
}

/** Every file in the scope with the context its readable path is built from. A key used by several rows appears once. */
export async function collectFiles(db: Pick<Db, 'query'>, scope: Scope): Promise<FileEntry[]> {
  const q = db.query.bind(db) as Q
  const where = scope.type === 'all' ? 'true' : WHERE[scope.type]
  const params = scope.type === 'all' ? [] : [scope.id]
  const out = new Map<string, FileEntry>()
  const add = (e: Omit<FileEntry, 'snapshotRevs'>) => { if (e.key && !out.has(e.key)) out.set(e.key, { ...e, snapshotRevs: [] }) }
  const base = (r: any) => ({ company: r.company, project: r.project, plan: r.plan })
  const planScope = ['all', 'company', 'project', 'document'].includes(scope.type)

  if (planScope) {
    const plans = await q<any>(
      `SELECT r.file_key, r.revision, r.created_at, r.label, r.original_name, d.name AS plan, p.id AS project_id, p.name AS project, c.id AS company_id, c.name AS company
       FROM document_revisions r JOIN documents d ON d.id = r.document_id JOIN projects p ON p.id = d.project_id JOIN companies c ON c.id = p.company_id
       WHERE ${where} ORDER BY p.id, d.id, r.revision`, params)
    for (const r of plans)
      add({ key: r.file_key, holder: 'plan', companyId: r.company_id, projectId: r.project_id,
        ctx: { kind: 'plan', ext: extOf(r.file_key), ...base(r), rev: r.revision, at: r.created_at, original: r.original_name || r.label || '' } })
  }

  const photos = await q<any>(
    `SELECT a.file_key, a.annotated_key, a.caption, a.created_at, m.tag, dt.name AS device_type, d.name AS plan, p.id AS project_id, p.name AS project, c.id AS company_id, c.name AS company
     FROM attachments a JOIN markups m ON m.id = a.markup_id JOIN documents d ON d.id = m.document_id JOIN projects p ON p.id = d.project_id JOIN companies c ON c.id = p.company_id
     LEFT JOIN device_types dt ON dt.id = m.device_type_id
     WHERE ${where} ORDER BY a.created_at, a.id`, params)
  for (const r of photos) {
    const common = { ...base(r), at: r.created_at, caption: r.caption, tag: r.tag, deviceType: r.device_type }
    add({ key: r.file_key, holder: 'photo', companyId: r.company_id, projectId: r.project_id, ctx: { kind: 'photo', ext: extOf(r.file_key), ...common } })
    if (r.annotated_key)
      add({ key: r.annotated_key, holder: 'photo', companyId: r.company_id, projectId: r.project_id, ctx: { kind: 'annotated', ext: extOf(r.annotated_key), ...common } })
  }

  // Photos frozen into revision snapshots: they may outlive their attachment row, and a moved key must be rewritten there too.
  const co = await scopeCompany(q, scope)
  const snaps = await q<any>(
    `SELECT r.id AS rid, d.id AS document_id, e->>'file_key' AS file_key, e->>'annotated_key' AS annotated_key, e->>'caption' AS caption, e->>'created_at' AS created_at,
            m.tag, dt.name AS device_type, d.name AS plan, p.id AS project_id, p.name AS project, c.id AS company_id, c.name AS company
     FROM document_revisions r JOIN documents d ON d.id = r.document_id JOIN projects p ON p.id = d.project_id JOIN companies c ON c.id = p.company_id
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.attachments_snapshot) = 'array' THEN r.attachments_snapshot ELSE '[]'::jsonb END) e
     LEFT JOIN markups m ON m.id = CASE WHEN (e->>'markup_id') ~* '^[0-9a-f-]{36}$' THEN (e->>'markup_id')::uuid END
     LEFT JOIN device_types dt ON dt.id = m.device_type_id
     WHERE r.attachments_snapshot IS NOT NULL AND ($1::uuid IS NULL OR p.company_id = $1::uuid)
     ORDER BY r.revision`, [co])
  const revs = new Map<string, Set<string>>()
  const note = (k: string | null, rid: string) => { if (k) { if (!revs.has(k)) revs.set(k, new Set()); revs.get(k)!.add(rid) } }
  for (const r of snaps) {
    note(r.file_key, r.rid); note(r.annotated_key, r.rid)
    const inScope = scope.type === 'all' || scope.type === 'company' || (scope.type === 'project' && r.project_id === scope.id) || (scope.type === 'document' && r.document_id === scope.id)
    if (!inScope) continue
    const common = { ...base(r), at: r.created_at, caption: r.caption ?? '', tag: r.tag ?? '', deviceType: r.device_type ?? '' }
    if (r.file_key) add({ key: r.file_key, holder: 'photo', companyId: r.company_id, projectId: r.project_id, ctx: { kind: 'photo', ext: extOf(r.file_key), ...common } })
    if (r.annotated_key) add({ key: r.annotated_key, holder: 'photo', companyId: r.company_id, projectId: r.project_id, ctx: { kind: 'annotated', ext: extOf(r.annotated_key), ...common } })
  }

  if (scope.type === 'all' || scope.type === 'company') {
    const logos = await q<any>(
      `SELECT c.id AS company_id, c.name AS company, s.value->>'logo_key' AS key FROM settings s JOIN companies c ON c.id = s.company_id
       WHERE s.key = 'company' AND coalesce(s.value->>'logo_key', '') <> '' AND ($1::uuid IS NULL OR c.id = $1::uuid)`, [scope.type === 'all' ? null : scope.id])
    for (const r of logos) add({ key: r.key, holder: 'company-logo', companyId: r.company_id, projectId: null, ctx: { kind: 'company-logo', ext: extOf(r.key), company: r.company } })
  }
  if (['all', 'company', 'project'].includes(scope.type)) {
    const logos = await q<any>(
      `SELECT p.id AS project_id, p.name AS project, c.id AS company_id, c.name AS company, p.settings->'report'->>'logo_key' AS key
       FROM projects p JOIN companies c ON c.id = p.company_id
       WHERE coalesce(p.settings->'report'->>'logo_key', '') <> '' AND ${where}`, params)
    for (const r of logos) add({ key: r.key, holder: 'project-logo', companyId: r.company_id, projectId: r.project_id, ctx: { kind: 'project-logo', ext: extOf(r.key), company: r.company, project: r.project } })
  }
  if (scope.type === 'all') {
    for (const u of await q<any>("SELECT email, avatar_key AS key FROM users WHERE coalesce(avatar_key, '') <> ''"))
      add({ key: u.key, holder: 'avatar', companyId: null, projectId: null, ctx: { kind: 'avatar', ext: extOf(u.key), email: u.email } })
  }

  for (const e of out.values()) e.snapshotRevs = [...(revs.get(e.key) ?? [])]
  return [...out.values()]
}

export interface MovePlan { files: number; legacy: number; moves: Move[] }

/** The files of the scope that are not at the path they should have. Legacy `<uuid>.<ext>` files only when `includeLegacy`. */
export async function planMoves(db: Pick<Db, 'query'>, storage: Storage, scope: Scope, opts: { includeLegacy?: boolean; skip?: Set<string> } = {}): Promise<MovePlan> {
  const entries = await collectFiles(db, scope)
  const moves: Move[] = []
  let legacy = 0
  for (const e of entries) {
    if (opts.skip?.has(e.key)) continue
    let from: string
    try { from = await storage.pathOf(e.key) } catch { continue }
    const old = isLegacyName(from)
    if (old) legacy++
    if (old && !opts.includeLegacy) continue
    const to = buildPath(e.ctx)
    if (samePlace(from, to)) continue
    moves.push({ key: e.key, from, to, entry: e })
  }
  return { files: entries.length, legacy, moves }
}

/** Points every column and JSON document that names `oldKey` at `newKey`. With a hint only the rows that can hold it are scanned. */
export async function updateRefs(q: Q, oldKey: string, newKey: string, hint?: Pick<FileEntry, 'holder' | 'companyId' | 'projectId' | 'snapshotRevs'>) {
  await q('UPDATE document_revisions SET file_key = $2 WHERE file_key = $1', [oldKey, newKey])
  await q('UPDATE attachments SET file_key = $2 WHERE file_key = $1', [oldKey, newKey])
  await q('UPDATE attachments SET annotated_key = $2 WHERE annotated_key = $1', [oldKey, newKey])
  await q('UPDATE users SET avatar_key = $2 WHERE avatar_key = $1', [oldKey, newKey])
  // JSON documents: replace the quoted string, so only a value equal to the whole key matches.
  const jo = JSON.stringify(oldKey), jn = JSON.stringify(newKey)
  if (!hint) {
    await q(`UPDATE document_revisions SET attachments_snapshot = replace(attachments_snapshot::text, $1, $2)::jsonb
             WHERE attachments_snapshot IS NOT NULL AND position($1 in attachments_snapshot::text) > 0`, [jo, jn])
    await q('UPDATE settings SET value = replace(value::text, $1, $2)::jsonb WHERE position($1 in value::text) > 0', [jo, jn])
    await q('UPDATE projects SET settings = replace(settings::text, $1, $2)::jsonb WHERE position($1 in settings::text) > 0', [jo, jn])
    return
  }
  if (hint.snapshotRevs.length)
    await q('UPDATE document_revisions SET attachments_snapshot = replace(attachments_snapshot::text, $1, $2)::jsonb WHERE id = ANY($3::uuid[])', [jo, jn, hint.snapshotRevs])
  if (hint.holder === 'company-logo' && hint.companyId)
    await q("UPDATE settings SET value = replace(value::text, $1, $2)::jsonb WHERE key = 'company' AND company_id = $3", [jo, jn, hint.companyId])
  if (hint.holder === 'project-logo' && hint.projectId)
    await q('UPDATE projects SET settings = replace(settings::text, $1, $2)::jsonb WHERE id = $3', [jo, jn, hint.projectId])
}

/**
 * Moves one file and rewrites everything that points at it: the file is copied to its new path, the database is updated in
 * one transaction, and only then is the original removed. Returns the new key.
 */
export async function relocateKey(db: Db, storage: Storage, oldKey: string, newPath: string, hint?: Parameters<typeof updateRefs>[3]): Promise<string> {
  return storage.relocate(oldKey, newPath, async newKey => { await db.transaction(q => updateRefs(q, oldKey, newKey, hint)) })
}

export interface JobRow {
  id: string; kind: 'relayout' | 'organize'; scope: string; scope_id: string | null; company_id: string | null; status: string
  attempts: number; total: number; moved: number; failed: number; failed_keys: string[]; last_error: string
  created_at: string; updated_at: string; next_run_at: string
}

const MAX_ATTEMPTS = 5
const scopeOf = (j: JobRow): Scope => (j.scope === 'all' ? { type: 'all' } : { type: j.scope as any, id: j.scope_id! })

export interface RelayoutOptions {
  /** Files moved per batch. */
  batch?: number
  /** Poll interval of the background worker. */
  intervalMs?: number
  /** Days removed files stay in _trash (the worker purges older ones about every 6 hours). */
  trashDays?: () => Promise<number>
}

export class Relayout {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private lastPurge = 0
  private batch: number

  constructor(private db: Db, private storage: Storage, private opts: RelayoutOptions = {}) { this.batch = opts.batch ?? 25 }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.run() }, this.opts.intervalMs ?? 5000)
    this.timer.unref?.()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }

  /** Works through the open jobs until nothing is due. Never throws. */
  async run() {
    if (this.busy) return
    this.busy = true
    try {
      for (let n = 0; n < 100_000 && await this.tick(); n++) await new Promise(r => setImmediate(r))
      if (this.opts.trashDays && Date.now() - this.lastPurge > 6 * 3_600_000) { this.lastPurge = Date.now(); await this.purge() }
    } catch (e) { console.warn('[relayout]', (e as Error).message) } finally { this.busy = false }
  }

  /** Runs jobs until none is due (for tests and for waiting on a job). */
  async drain() { while (await this.tick()) { /* keep going */ } }

  async purge(): Promise<number> {
    const days = await this.opts.trashDays?.()
    return days && days > 0 ? this.storage.purgeTrash(days) : 0
  }

  /** Queues a job unless the same one is already waiting. 'all' needs no id. */
  async enqueue(kind: JobRow['kind'], scope: Scope, by?: string | null): Promise<JobRow> {
    const id = scope.type === 'all' ? null : scope.id
    const [open] = await this.db.query<JobRow>(
      `SELECT * FROM relayout_jobs WHERE kind = $1 AND scope = $2 AND scope_id IS NOT DISTINCT FROM $3 AND status IN ('pending','running') ORDER BY created_at LIMIT 1`, [kind, scope.type, id])
    if (open) return open
    const co = scope.type === 'company' ? scope.id : scope.type === 'all' ? null : await scopeCompany(this.db.query, scope)
    const [job] = await this.db.query<JobRow>(
      'INSERT INTO relayout_jobs (kind, scope, scope_id, company_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [kind, scope.type, id, co, by ?? null])
    return job
  }

  /** The newest organize job of a company (or of "all companies" when companyId is null). */
  async organizeStatus(companyId: string | null) {
    const [j] = await this.db.query<JobRow>(
      `SELECT * FROM relayout_jobs WHERE kind = 'organize' AND ${companyId ? 'scope = \'company\' AND company_id = $1' : "scope = 'all' AND $1::uuid IS NULL"} ORDER BY created_at DESC LIMIT 1`, [companyId])
    return j ? jobView(j) : { status: 'none' as const, total: 0, moved: 0, failed: 0, error: '' }
  }

  /** True while the background worker is polling. */
  get started() { return !!this.timer }

  private chain: Promise<unknown> = Promise.resolve()
  /** One batch of the oldest due job. Returns false when there was nothing to do. Calls never overlap. */
  tick(): Promise<boolean> {
    const run = this.chain.then(() => this.tickOnce())
    this.chain = run.catch(() => {})
    return run
  }

  private async tickOnce(): Promise<boolean> {
    const [job] = await this.db.query<JobRow>(
      `SELECT * FROM relayout_jobs WHERE status IN ('pending','running') AND next_run_at <= now() ORDER BY created_at, id LIMIT 1`)
    if (!job) return false
    const failedKeys = new Set<string>(Array.isArray(job.failed_keys) ? job.failed_keys : [])
    let { total, moved, failed, last_error: lastError } = job
    let status = 'running', attempts = job.attempts
    let nextRun = 'now()'
    try {
      const plan = await planMoves(this.db, this.storage, scopeOf(job), { includeLegacy: job.kind === 'organize', skip: failedKeys })
      if (job.kind === 'organize' && job.status === 'pending') total = plan.moves.length
      if (!plan.moves.length) {
        if (failedKeys.size && job.kind === 'relayout' && attempts + 1 < MAX_ATTEMPTS) {
          // Something could not be moved: try again later, from scratch.
          attempts++; status = 'pending'; failedKeys.clear(); nextRun = `now() + interval '${Math.min(60, 2 ** attempts)} minutes'`
        } else status = failedKeys.size && job.kind === 'relayout' ? 'failed' : 'done'
      } else {
        for (const m of plan.moves.slice(0, this.batch)) {
          try {
            await relocateKey(this.db, this.storage, m.key, m.to, m.entry)
            moved++
          } catch (e) {
            failed++; failedKeys.add(m.key); lastError = `${m.from}: ${(e as Error).message}`.slice(0, 500)
          }
        }
      }
    } catch (e) {
      attempts++; lastError = (e as Error).message.slice(0, 500)
      status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
      nextRun = `now() + interval '${Math.min(60, 2 ** attempts)} minutes'`
    }
    await this.db.query(
      `UPDATE relayout_jobs SET status = $2, attempts = $3, total = $4, moved = $5, failed = $6, failed_keys = $7, last_error = $8, updated_at = now(), next_run_at = ${nextRun} WHERE id = $1`,
      [job.id, status, attempts, total, moved, failed, JSON.stringify([...failedKeys]), lastError])
    return true
  }
}

export function jobView(j: JobRow) {
  return {
    id: j.id, status: j.status as 'pending' | 'running' | 'done' | 'failed', total: j.total, moved: j.moved, failed: j.failed,
    error: j.last_error, started_at: j.created_at, updated_at: j.updated_at,
  }
}
