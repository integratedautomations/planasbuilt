// Wiring graph: devices are nodes, cables locked to two devices are edges. Hubs (panels, controllers, switches, NVRs, power
// supplies, racks...) become the columns of the riser; every other device hangs under the hub it is cabled to, directly (a
// home run) or through a daisy chain (fire alarm loops, NAC circuits, door readers on a controller). Pure, no React.
import { cableCount, cableLength, cableTypeId, danglingEnds, linkedEnds, viaOf } from '../markups/cables'
import { polylineLength } from '../markups/measure'
import type { CableSettings } from '../markups/cables'
import { naturalCompare } from '../markups/stacks'
import { resolveMount } from '../markups/mount'
import type { Mount } from '../markups/mount'
import type { Markup, PathGeometry, SymbolSet } from '../markups/types'
import type { CableType, DeviceType } from '../catalog/types'

/** Types that are field modules, boxes or end devices even when they are drawn with the square mount. */
const SQUARE_LEAF = /\b(module|isolator|duct|water ?flow|flow switch|tamper|supervisory|j-?box|back ?box|pull box|conduit|floor box|relay|turnstile|gate|valve|desk station|stub)\b/i
/** Types that act as a hub whatever mount they use. */
const HUB_NAME = /\b(panel|facp|controller|nvr|dvr|recorder|power supply|psu|rack|mdf|idf|head.?end|extender|amplifier|processor|patch|firewall|router|gateway|demarc|server|communicator|dact|receiver|booster|ups|master)\b|network switch|poe switch|ethernet switch|managed switch|^switch$/i

/**
 * Whether a device type is a hub of the riser: anything drawn with the square mount (panels, controllers, switches, NVRs,
 * power supplies, racks) or named like one, except the small field modules and boxes that share the square mount.
 */
export function isHubType(typeName: string, mount: Mount): boolean {
  const name = typeName.trim()
  if (SQUARE_LEAF.test(name)) return false
  return mount === 'square' || HUB_NAME.test(name)
}

export interface WNode {
  id: string
  tag: string
  typeName: string
  typeId: string
  setId: string
  setName: string
  /** Symbol set colour. */
  color: string
  mount: Mount
  hub: boolean
  documentId: string
  documentName: string
  page: number
}

export interface WLink {
  cableId: string
  /** Cable type name ('' = none). */
  typeName: string
  color: string
  /** Total length of the cable (slack, drops and run count included); null without a scale. */
  lengthFt: number | null
  count: number
  /** Other cables between the same two devices. */
  parallel: number
}

export interface WRunItem { node: WNode; link: WLink; /** The device this cable comes from (the hub, or the previous device on the chain). */ from: string }
export interface WRun {
  items: WRunItem[]
  /** The hub, or the chain device this run branches off. */
  from: string
  /** The last device is also cabled back to the hub (a class A loop). */
  loopBack: WLink | null
  /** A single device cabled straight to the hub. */
  homeRun: boolean
}
export interface WHub { node: WNode; runs: WRun[]; uplink: { from: WNode; link: WLink } | null; children: WHub[] }

export type NotConnectedReason = 'no-cable' | 'no-hub'
export interface WCableProblem { cableId: string; typeName: string; documentId: string; documentName: string; page: number; reason: 'open-end' | 'one-end' | 'no-ends' | 'same-device'; /** Tags at the linked ends. */ tags: string[] }

export interface Wiring {
  /** Hub trees, ordered by plan, page and tag. */
  roots: WHub[]
  /** Every hub in tree order (parents before children). */
  hubs: WHub[]
  notConnected: { devices: { node: WNode; reason: NotConnectedReason }[]; cables: WCableProblem[] }
  counts: { devices: number; hubs: number; cables: number; connected: number }
}

export interface WiringContext {
  symbolSets: Map<string, SymbolSet>
  /** Device types by id (name and default mount). */
  types: ReadonlyMap<string, Pick<DeviceType, 'name' | 'mount'>>
  cableTypes: ReadonlyMap<string, CableType>
  docNames: ReadonlyMap<string, string>
  scaleFor: (documentId: string, page: number) => number | null
  defaults: CableSettings
  /** Replace the hub test (default: isHubType on the type name and mount). */
  isHub?: (node: Omit<WNode, 'hub'>) => boolean
}

const tagCmp = (a: WNode, b: WNode) => naturalCompare(a.tag || a.id, b.tag || b.id)

/** Builds the wiring graph from every markup of a project (devices and cables; anything else is ignored). */
export function buildWiring(markups: Iterable<Markup>, ctx: WiringContext): Wiring {
  const all = [...markups]
  const byId = new Map(all.map(m => [m.id, m]))
  const nodes = new Map<string, WNode>()
  for (const m of all) {
    if (m.type !== 'device' || !('width' in m.geometry)) continue
    const set = m.symbol_set_id ? ctx.symbolSets.get(m.symbol_set_id) : undefined
    const type = m.device_type_id ? ctx.types.get(m.device_type_id) : undefined
    const base = {
      id: m.id, tag: m.tag ?? '', typeName: type?.name ?? set?.name ?? 'Device', typeId: m.device_type_id ?? '',
      setId: m.symbol_set_id ?? '', setName: set?.name ?? '', color: set?.color ?? '#868e96',
      mount: resolveMount(type?.mount, m.geometry.mount), documentId: m.document_id,
      documentName: ctx.docNames.get(m.document_id) ?? '', page: m.page,
    }
    nodes.set(m.id, { ...base, hub: (ctx.isHub ?? (n => isHubType(n.typeName, n.mount)))(base) })
  }

  // ---- edges
  interface Edge { link: WLink; a: string; b: string }
  const edges: Edge[] = []
  const problems: WCableProblem[] = []
  const cables = all.filter(m => m.type === 'cable' && 'points' in m.geometry).sort((x, y) => x.id.localeCompare(y.id))
  for (const c of cables) {
    const g = c.geometry as PathGeometry
    const live = linkedEnds(c, byId).filter(end => nodes.has(g[end]!))
    const tags = live.map(end => nodes.get(g[end]!)!.tag || '?')
    const typeName = ctx.cableTypes.get(cableTypeId(c))?.name ?? ''
    const problem = (reason: WCableProblem['reason']) => problems.push({
      cableId: c.id, typeName, documentId: c.document_id, documentName: ctx.docNames.get(c.document_id) ?? '', page: c.page, reason, tags,
    })
    if (danglingEnds(c, byId).length) { problem('open-end'); continue }
    if (live.length === 0) { problem('no-ends'); continue }
    if (live.length === 1) { problem('one-end'); continue }
    if (g.from === g.to) { problem('same-device'); continue }
    const len = cableLength(c, ctx.scaleFor(c.document_id, c.page), ctx.defaults, byId)
    const mk = (lengthFt: number | null): WLink => ({ cableId: c.id, typeName, color: ctx.cableTypes.get(cableTypeId(c))?.color ?? c.style.stroke ?? '#868e96', lengthFt, count: cableCount(c), parallel: 0 })
    // Home runs: a star from the From device to every device on the run, each with its own cable length
    if (len?.mode === 'home' && len.stops.length) {
      for (const s of len.stops) if (s.id !== g.from && nodes.has(s.id)) edges.push({ a: g.from!, b: s.id, link: mk(s.runFt * len.count) })
      continue
    }
    // A run through devices is a chain From -> via... -> To: one edge per hop, the cable's length shared by hop length
    const chain = [{ id: g.from!, at: 0 }, ...viaOf(g).filter(v => nodes.has(v.id)).map(v => ({ id: v.id, at: v.i })), { id: g.to!, at: g.points.length / 2 - 1 }]
    if (chain.length === 2) { edges.push({ a: g.from!, b: g.to!, link: mk(len ? len.totalFt : null) }); continue }
    const total = polylineLength(g.points) || 1
    for (let k = 0; k + 1 < chain.length; k++) {
      if (chain[k].id === chain[k + 1].id) continue
      const part = polylineLength(g.points.slice(chain[k].at * 2, chain[k + 1].at * 2 + 2))
      edges.push({ a: chain[k].id, b: chain[k + 1].id, link: mk(len ? len.totalFt * (part / total) : null) })
    }
  }

  // ---- adjacency (parallel cables between the same pair collapse onto the first)
  const adj = new Map<string, { other: string; link: WLink }[]>()
  const seenPair = new Map<string, WLink>()
  for (const e of edges) {
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`
    const first = seenPair.get(key)
    if (first) { first.parallel++; continue }
    seenPair.set(key, e.link)
    for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) {
      const l = adj.get(x)
      if (l) l.push({ other: y, link: e.link }); else adj.set(x, [{ other: y, link: e.link }])
    }
  }
  for (const l of adj.values()) l.sort((p, q) => tagCmp(nodes.get(p.other)!, nodes.get(q.other)!))
  const neighbours = (id: string) => adj.get(id) ?? []

  // ---- hubs and the leaves under them
  const hubs = new Map<string, WHub>()
  for (const n of nodes.values()) if (n.hub) hubs.set(n.id, { node: n, runs: [], uplink: null, children: [] })

  const unhomed: WNode[] = []
  const visited = new Set<string>()
  const compOf = (start: string): string[] => {
    const comp: string[] = [], stack = [start]
    visited.add(start)
    while (stack.length) {
      const id = stack.pop()!
      comp.push(id)
      for (const { other } of neighbours(id)) if (!nodes.get(other)!.hub && !visited.has(other)) { visited.add(other); stack.push(other) }
    }
    return comp
  }
  const sortedLeaves = [...nodes.values()].filter(n => !n.hub).sort(tagCmp)
  for (const leaf of sortedLeaves) {
    if (visited.has(leaf.id)) continue
    const comp = compOf(leaf.id)
    const inComp = new Set(comp)
    // Hubs this group of devices is cabled to, and how far each is (sum of hops to every device)
    const attached = new Set<string>()
    for (const id of comp) for (const { other } of neighbours(id)) if (nodes.get(other)!.hub) attached.add(other)
    if (attached.size === 0) {
      if (comp.length > 1 || neighbours(comp[0]).length) for (const id of comp) unhomed.push(nodes.get(id)!)
      continue
    }
    const hops = (hub: string) => {
      const dist = new Map<string, number>()
      let frontier = neighbours(hub).map(n => n.other).filter(o => inComp.has(o))
      let d = 1
      while (frontier.length) {
        const next: string[] = []
        for (const id of frontier) if (!dist.has(id)) { dist.set(id, d); for (const { other } of neighbours(id)) if (inComp.has(other) && !dist.has(other)) next.push(other) }
        frontier = next; d++
      }
      return [...dist.values()].reduce((s, v) => s + v, 0)
    }
    const home = [...attached].sort((p, q) => hops(p) - hops(q) || tagCmp(nodes.get(p)!, nodes.get(q)!))[0]
    const hub = hubs.get(home)!
    // Walk the group from the hub: each entry device starts a run; a device with several onward devices continues with the first
    // and starts a new run for each of the others, so a chain reads in order and branches are labelled.
    const used = new Set<string>()
    const queue: { from: string; to: string; link: WLink }[] = neighbours(home).filter(n => inComp.has(n.other)).map(n => ({ from: home, to: n.other, link: n.link }))
    while (queue.length) {
      const start = queue.shift()!
      if (used.has(start.to)) continue
      const run: WRun = { items: [], from: start.from, loopBack: null, homeRun: false }
      let cur = start
      for (;;) {
        used.add(cur.to)
        const node = nodes.get(cur.to)!
        run.items.push({ node, link: cur.link, from: cur.from })
        const onward = neighbours(cur.to).filter(n => inComp.has(n.other) && !used.has(n.other) && n.other !== cur.from)
        const next = onward
        if (!next.length) {
          const back = neighbours(cur.to).find(n => n.other === home && n.link !== cur.link && run.items.length > 1)
          if (back) run.loopBack = back.link
          break
        }
        for (const extra of next.slice(1)) queue.push({ from: cur.to, to: extra.other, link: extra.link })
        cur = { from: cur.to, to: next[0].other, link: next[0].link }
      }
      run.homeRun = run.items.length === 1 && run.from === home
      hub.runs.push(run)
    }
  }

  // ---- hub to hub: a spanning forest rooted at the best connected hub of each group
  const hubDegree = (id: string) => neighbours(id).filter(n => hubs.has(n.other)).length
  // A hub with no cable at all has nothing to draw: it is listed under Not connected instead
  const hubOrder = [...hubs.values()].filter(h => neighbours(h.node.id).length > 0).sort((p, q) => hubDegree(q.node.id) - hubDegree(p.node.id) || tagCmp(p.node, q.node))
  const seen = new Set<string>()
  const roots: WHub[] = []
  const treeOrder: WHub[] = []
  for (const h of hubOrder) {
    if (seen.has(h.node.id)) continue
    seen.add(h.node.id)
    roots.push(h)
    const queue = [h]
    while (queue.length) {
      const cur = queue.shift()!
      treeOrder.push(cur)
      for (const { other, link } of neighbours(cur.node.id)) {
        const child = hubs.get(other)
        if (!child || seen.has(other)) continue
        seen.add(other)
        child.uplink = { from: cur.node, link }
        cur.children.push(child)
        queue.push(child)
      }
    }
  }
  const planKey = (n: WNode) => `${n.documentName}\u0000${String(n.page).padStart(6, '0')}`
  roots.sort((p, q) => naturalCompare(planKey(p.node), planKey(q.node)) || tagCmp(p.node, q.node))
  for (const h of hubs.values()) h.children.sort((p, q) => tagCmp(p.node, q.node))
  // Pre-order so a parent is always followed by its subtree
  const ordered: WHub[] = []
  const walk = (h: WHub) => { ordered.push(h); h.children.forEach(walk) }
  roots.forEach(walk)

  // ---- QA: devices with no cable, and groups that never reach a hub
  const connectedIds = new Set<string>()
  for (const [id, l] of adj) if (l.length) connectedIds.add(id)
  const lonely: { node: WNode; reason: NotConnectedReason }[] = []
  for (const n of [...nodes.values()].sort((p, q) => naturalCompare(planKey(p), planKey(q)) || tagCmp(p, q))) {
    if (!connectedIds.has(n.id)) lonely.push({ node: n, reason: 'no-cable' })
    else if (unhomed.includes(n)) lonely.push({ node: n, reason: 'no-hub' })
  }
  problems.sort((p, q) => naturalCompare(p.documentName, q.documentName) || p.page - q.page || p.cableId.localeCompare(q.cableId))

  const connected = [...nodes.keys()].filter(id => connectedIds.has(id) && !unhomed.some(u => u.id === id)).length
  return {
    roots, hubs: ordered,
    notConnected: { devices: lonely, cables: problems },
    counts: { devices: nodes.size, hubs: hubs.size, cables: cables.length, connected },
  }
}

/** Human text for a cable problem. */
export function problemText(p: WCableProblem): string {
  switch (p.reason) {
    case 'open-end': return 'An end lost its device'
    case 'one-end': return p.tags.length ? `Only linked to ${p.tags[0]}` : 'Only one end linked'
    case 'no-ends': return 'Not linked to any device'
    case 'same-device': return 'Both ends on the same device'
  }
}

export const NOT_CONNECTED_TEXT: Record<NotConnectedReason, string> = {
  'no-cable': 'No cable',
  'no-hub': 'Cabled, but not to a panel, controller or switch',
}

