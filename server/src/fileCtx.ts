// The names around a file, read from the database when it is saved (fileLayout.ts turns them into a path).
import type { Db } from './db.js'
import type { FileCtx } from './fileLayout.js'

type Reader = Pick<Db, 'query'>

/** Company and project names of a project. */
export async function projectNames(db: Reader, projectId: string): Promise<{ company: string; project: string }> {
  const [r] = await db.query<{ company: string; project: string }>(
    'SELECT c.name AS company, p.name AS project FROM projects p JOIN companies c ON c.id = p.company_id WHERE p.id = $1', [projectId])
  return r ?? { company: '', project: '' }
}

export async function companyNameOf(db: Reader, companyId: string | null | undefined): Promise<string> {
  if (!companyId) return ''
  return (await db.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId]))[0]?.name ?? ''
}

/** Context of a plan PDF. `rev` is the revision number it is saved as. */
export async function planCtx(db: Reader, projectId: string, plan: string, rev: number, original: string, label = ''): Promise<FileCtx> {
  return { kind: 'plan', ext: 'pdf', ...(await projectNames(db, projectId)), plan, rev, at: new Date(), original: original || label }
}

/** Context of a photo (or its marked-up copy) attached to a markup. */
export async function photoCtx(db: Reader, markupId: string, ext: string, caption: string, annotated = false, at: Date | string = new Date()): Promise<FileCtx> {
  const [r] = await db.query<any>(
    `SELECT c.name AS company, p.name AS project, d.name AS plan, m.tag, dt.name AS device_type
     FROM markups m JOIN documents d ON d.id = m.document_id JOIN projects p ON p.id = d.project_id JOIN companies c ON c.id = p.company_id
     LEFT JOIN device_types dt ON dt.id = m.device_type_id WHERE m.id = $1`, [markupId])
  return { kind: annotated ? 'annotated' : 'photo', ext, company: r?.company, project: r?.project, plan: r?.plan, tag: r?.tag, deviceType: r?.device_type, caption, at }
}
