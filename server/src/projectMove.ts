// Moving a project to another company. Its markups point at the old company's symbol sets, device types, products and
// cable types, so each one in use is matched by name in the target company or copied there, and every reference follows:
// the live markups, the frozen revision snapshots, the project's tag prefixes and the sub members' scopes.
import type { Db } from './db.js'

export interface MoveSummary {
  ok: true
  project_id: string
  from_company_id: string
  company_id: string
  symbol_sets: { matched: number; copied: number }
  device_types: { matched: number; copied: number }
  products: { matched: number; copied: number }
  cable_types: { matched: number; copied: number }
  /** People who were not in the target company and joined it as guests so they keep their access. */
  members_added: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

export async function moveProject(db: Db, projectId: string, targetId: string):
  Promise<{ error: string; status: number } | { summary: MoveSummary; addedMembers: string[] }> {
  try {
    return await db.transaction(async q => {
      const [p] = await q<any>('SELECT id, company_id, settings FROM projects WHERE id = $1 FOR UPDATE', [projectId])
      if (!p) throw new Fail(404, 'Not found')
      const [target] = await q<any>('SELECT id FROM companies WHERE id = $1', [targetId])
      if (!target) throw new Fail(404, 'Company not found')
      if (p.company_id === targetId) throw new Fail(400, 'The project is already in that company')

      const sum = {
        symbol_sets: { matched: 0, copied: 0 }, device_types: { matched: 0, copied: 0 },
        products: { matched: 0, copied: 0 }, cable_types: { matched: 0, copied: 0 },
      }
      const sets = new Map<string, string>(), types = new Map<string, string>(), prods = new Map<string, string>(), cables = new Map<string, string>()
      const copiedTypes: { src: any; dst: string }[] = []

      const mapSet = async (src: string): Promise<string | null> => {
        if (sets.has(src)) return sets.get(src)!
        const [s] = await q<any>('SELECT * FROM symbol_sets WHERE id = $1', [src])
        if (!s) return null
        const [hit] = await q<any>(
          'SELECT id FROM symbol_sets WHERE company_id = $1 AND lower(btrim(name)) = $2 ORDER BY archived, sort, created_at LIMIT 1', [targetId, norm(s.name)])
        let id: string
        if (hit) { id = hit.id; sum.symbol_sets.matched++ } else {
          const [c] = await q<any>(
            `INSERT INTO symbol_sets (company_id, name, color, tag_prefix, icon, fields, has_fov, sort, archived)
             VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT coalesce(max(sort),0)+1 FROM symbol_sets WHERE company_id = $1),$8) RETURNING id`,
            [targetId, s.name, s.color, s.tag_prefix, s.icon, JSON.stringify(s.fields), s.has_fov, s.archived])
          id = c.id; sum.symbol_sets.copied++
        }
        sets.set(src, id)
        return id
      }

      const mapType = async (src: string): Promise<string | null> => {
        if (types.has(src)) return types.get(src)!
        const [t] = await q<any>('SELECT * FROM device_types WHERE id = $1', [src])
        if (!t) return null
        const setId = await mapSet(t.symbol_set_id)
        if (!setId) return null
        const [hit] = await q<any>(
          'SELECT id FROM device_types WHERE symbol_set_id = $1 AND lower(btrim(name)) = $2 ORDER BY archived, sort, created_at LIMIT 1', [setId, norm(t.name)])
        let id: string
        if (hit) { id = hit.id; sum.device_types.matched++ } else {
          const [c] = await q<any>(
            `INSERT INTO device_types (company_id, symbol_set_id, name, icon, tag_prefix, fields, coverage, mount, sort, archived)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT coalesce(max(sort),0)+1 FROM device_types WHERE symbol_set_id = $2),$9) RETURNING id`,
            [targetId, setId, t.name, t.icon, t.tag_prefix, JSON.stringify(t.fields), t.coverage ? JSON.stringify(t.coverage) : null, t.mount, t.archived])
          id = c.id; sum.device_types.copied++
          copiedTypes.push({ src: t, dst: id })
        }
        types.set(src, id)
        return id
      }

      const mapProduct = async (src: string): Promise<string | null> => {
        if (prods.has(src)) return prods.get(src)!
        const [pr] = await q<any>('SELECT * FROM products WHERE id = $1', [src])
        if (!pr) return null
        const typeId = pr.device_type_id ? await mapType(pr.device_type_id) : null
        const [hit] = await q<any>(
          `SELECT id FROM products WHERE company_id = $1 AND kind = $2 AND lower(btrim(manufacturer)) = $3 AND lower(btrim(model)) = $4
             AND lower(btrim(name)) = $5 AND device_type_id IS NOT DISTINCT FROM $6::uuid ORDER BY active DESC, created_at LIMIT 1`,
          [targetId, pr.kind, norm(pr.manufacturer), norm(pr.model), norm(pr.name), typeId])
        if (hit) { prods.set(src, hit.id); sum.products.matched++; return hit.id }
        const [c] = await q<any>(
          `INSERT INTO products (company_id, device_type_id, kind, manufacturer, model, name, spec_url, unit_cost, labor_hours, default_fields, accessories, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]',$11) RETURNING id`,
          [targetId, typeId, pr.kind, pr.manufacturer, pr.model, pr.name, pr.spec_url, pr.unit_cost, pr.labor_hours, JSON.stringify(pr.default_fields), pr.active])
        prods.set(src, c.id); sum.products.copied++
        // Accessories refer to other products by id: map those too, once this product has its id (they may refer back to it).
        const acc: any[] = []
        for (const a of Array.isArray(pr.accessories) ? pr.accessories : []) {
          if (a?.product_id) { const m = await mapProduct(a.product_id); if (m) acc.push({ ...a, product_id: m }) } else acc.push(a)
        }
        await q('UPDATE products SET accessories = $2 WHERE id = $1', [c.id, JSON.stringify(acc)])
        return c.id
      }

      const mapCable = async (src: string): Promise<string | null> => {
        if (cables.has(src)) return cables.get(src)!
        const [c] = await q<any>('SELECT * FROM cable_types WHERE id = $1', [src])
        if (!c) return null
        const [hit] = await q<any>(
          'SELECT id FROM cable_types WHERE company_id = $1 AND lower(btrim(name)) = $2 ORDER BY archived, sort, created_at LIMIT 1', [targetId, norm(c.name)])
        let id: string
        if (hit) { id = hit.id; sum.cable_types.matched++ } else {
          const [n] = await q<any>(
            `INSERT INTO cable_types (company_id, name, color, sort, archived)
             VALUES ($1,$2,$3,(SELECT coalesce(max(sort),0)+1 FROM cable_types WHERE company_id = $1),$4) RETURNING id`, [targetId, c.name, c.color, c.archived])
          id = n.id; sum.cable_types.copied++
        }
        cables.set(src, id)
        return id
      }

      // --- everything the project refers to
      const docIds = (await q<{ id: string }>('SELECT id FROM documents WHERE project_id = $1', [projectId])).map(d => d.id)
      const usedIds = async (col: string) => (await q<{ v: string }>(
        `SELECT DISTINCT ${col} AS v FROM markups WHERE document_id = ANY($1::uuid[]) AND ${col} IS NOT NULL`, [docIds])).map(r => r.v)
      const wantSets = new Set(await usedIds('symbol_set_id'))
      const wantTypes = new Set(await usedIds('device_type_id'))
      const wantProducts = new Set(await usedIds('product_id'))
      const wantCables = new Set((await q<{ v: string }>(
        `SELECT DISTINCT fields->>'cable_type' AS v FROM markups WHERE document_id = ANY($1::uuid[]) AND fields->>'cable_type' IS NOT NULL`, [docIds])).map(r => r.v))
      const revs = await q<{ id: string; markups_snapshot: any }>(
        'SELECT id, markups_snapshot FROM document_revisions WHERE document_id = ANY($1::uuid[]) AND markups_snapshot IS NOT NULL', [docIds])
      for (const r of revs) for (const m of Array.isArray(r.markups_snapshot) ? r.markups_snapshot : []) {
        if (m?.symbol_set_id) wantSets.add(m.symbol_set_id)
        if (m?.device_type_id) wantTypes.add(m.device_type_id)
        if (m?.product_id) wantProducts.add(m.product_id)
        if (m?.fields?.cable_type) wantCables.add(m.fields.cable_type)
      }
      const settings = p.settings && typeof p.settings === 'object' ? p.settings : {}
      const prefixes = settings.tag_prefixes && typeof settings.tag_prefixes === 'object' ? settings.tag_prefixes : {}
      for (const k of Object.keys(prefixes)) if (UUID_RE.test(k)) wantSets.add(k)
      const members = await q<any>('SELECT user_id, scope FROM project_members WHERE project_id = $1', [projectId])
      for (const m of members) for (const s of m.scope?.sets ?? []) wantSets.add(s)

      for (const id of wantSets) if (UUID_RE.test(String(id))) await mapSet(id)
      for (const id of wantTypes) if (UUID_RE.test(String(id))) await mapType(id)
      for (const id of wantProducts) if (UUID_RE.test(String(id))) await mapProduct(id)
      for (const id of wantCables) if (UUID_RE.test(String(id))) await mapCable(id)
      // A copied type keeps its default product (copied or matched in the target).
      for (const c of copiedTypes) {
        if (!c.src.default_product_id) continue
        const d = await mapProduct(c.src.default_product_id)
        if (d) await q('UPDATE device_types SET default_product_id = $2 WHERE id = $1', [c.dst, d])
      }

      // --- rewrite the references
      const re = (m: Map<string, string>, v: unknown) => (typeof v === 'string' && m.has(v) ? m.get(v)! : v)
      for (const [col, m] of [['symbol_set_id', sets], ['device_type_id', types], ['product_id', prods]] as const)
        for (const [from, to] of m)
          await q(`UPDATE markups SET ${col} = $2 WHERE ${col} = $1 AND document_id = ANY($3::uuid[])`, [from, to, docIds])
      for (const [from, to] of cables)
        await q(`UPDATE markups SET fields = jsonb_set(fields, '{cable_type}', to_jsonb($2::text)) WHERE fields->>'cable_type' = $1 AND document_id = ANY($3::uuid[])`, [from, to, docIds])
      for (const r of revs) {
        const next = (Array.isArray(r.markups_snapshot) ? r.markups_snapshot : []).map((m: any) => {
          if (!m || typeof m !== 'object') return m
          const out = { ...m, symbol_set_id: re(sets, m.symbol_set_id), device_type_id: re(types, m.device_type_id), product_id: re(prods, m.product_id) }
          if (m.fields?.cable_type) out.fields = { ...m.fields, cable_type: re(cables, m.fields.cable_type) }
          return out
        })
        await q('UPDATE document_revisions SET markups_snapshot = $2 WHERE id = $1', [r.id, JSON.stringify(next)])
      }
      const newPrefixes: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(prefixes)) newPrefixes[String(re(sets, k))] = v
      await q('UPDATE projects SET settings = $2, company_id = $3 WHERE id = $1',
        [projectId, JSON.stringify({ ...settings, ...(Object.keys(prefixes).length ? { tag_prefixes: newPrefixes } : {}) }), targetId])
      for (const m of members) {
        const sc = m.scope
        if (sc?.sets?.length) await q('UPDATE project_members SET scope = $3 WHERE project_id = $1 AND user_id = $2',
          [projectId, m.user_id, JSON.stringify({ ...sc, sets: [...new Set(sc.sets.map((s: string) => re(sets, s)))] })])
      }

      // --- people keep their access: members of the project who are not in the target company join it as guests
      const added = (await q<{ user_id: string }>(
        `INSERT INTO company_members (company_id, user_id, role)
         SELECT $1, m.user_id, 'guest' FROM project_members m WHERE m.project_id = $2
         ON CONFLICT (company_id, user_id) DO NOTHING RETURNING user_id`, [targetId, projectId])).map(r => r.user_id)

      return {
        addedMembers: added,
        summary: { ok: true as const, project_id: projectId, from_company_id: p.company_id, company_id: targetId, ...sum, members_added: added.length },
      }
    })
  } catch (e) {
    if (e instanceof Fail) return { error: e.message, status: e.status }
    throw e
  }
}

class Fail extends Error { constructor(readonly status: number, message: string) { super(message) } }
