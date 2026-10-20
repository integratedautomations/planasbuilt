/**
 * Best-effort reader for Bluebeam Revu tool sets (.btx).
 *
 * LIMITATIONS: the format is not publicly documented. This follows the commonly seen layout: an XML file whose
 * tool items (ToolChestItem / Item / Tool) hold the markup definition as a hex or base64 string, usually zlib
 * compressed, containing a PDF annotation dictionary (/Subj, /Contents ...). We read the tool's title, its
 * Subject and, when a PNG/JPEG is embedded or supplied in an Image/Icon element, an icon. Appearance (colours,
 * line styles, custom columns) is NOT imported. Anything we cannot decode is still listed by its title so the
 * admin can map it by hand. Unverified against real files; treat the result as a starting list.
 */

export interface BtxTool {
  /** Name shown in the tool chest. */
  title: string
  /** PDF /Subj of the stored markup (what Revu lists in the markups list), '' when not decodable. */
  subject: string
  /** data: URL of an embedded PNG/JPEG, or undefined. */
  icon?: string
  /** Whether the stored markup data could be decoded. */
  decoded: boolean
  /** Revu 2018+ grouped tools: real name (description), model, tag label (e.g. "S-P"), layer (e.g. "Nurse Call"), drawn SVG. */
  name?: string
  model?: string
  label?: string
  layer?: string
  svg?: string
}

const ITEM_TAGS = ['ToolChestItem', 'ToolItem', 'Tool', 'Item']
const TITLE_TAGS = ['Title', 'Name', 'Label', 'Caption']
const ICON_TAGS = ['Image', 'Icon', 'Thumbnail', 'Preview', 'Bitmap']

const xmlText = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&')

interface El { tag: string; attrs: Record<string, string>; inner: string }

/** Top-level elements named `tags` inside xml (non-nested for the same tag). Tolerant, regex based. */
function elements(xml: string, tags: string[]): El[] {
  const out: El[] = []
  const re = new RegExp(`<(${tags.join('|')})(\\s[^>]*?)?(/>|>)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const tag = m[1]
    const attrs: Record<string, string> = {}
    for (const a of (m[2] ?? '').matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1]] = xmlText(a[3] ?? a[4] ?? '')
    if (m[3] === '/>') { out.push({ tag, attrs, inner: '' }); continue }
    const close = xml.indexOf(`</${tag}>`, re.lastIndex)
    if (close < 0) continue
    out.push({ tag, attrs, inner: xml.slice(re.lastIndex, close) })
  }
  return out
}

/** Child elements of any name (non-nested lookup is enough for tool items). */
function children(inner: string): El[] {
  const out: El[] = []
  for (const m of inner.matchAll(/<([A-Za-z][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) out.push({ tag: m[1], attrs: {}, inner: m[2] })
  return out
}

const childText = (inner: string, tags: string[]): string => {
  const e = elements(inner, tags)[0]
  return e ? xmlText(e.inner.replace(/<[^>]+>/g, '')).trim() : ''
}

function bytesFromEncoded(s: string): Uint8Array | null {
  const t = s.replace(/\s+/g, '')
  if (t.length < 16) return null
  try {
    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) {
      const out = new Uint8Array(t.length / 2)
      for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16)
      return out
    }
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(t) && t.length % 4 === 0) {
      const bin = atob(t)
      return Uint8Array.from(bin, c => c.charCodeAt(0))
    }
  } catch { /* not decodable */ }
  return null
}

async function inflate(bytes: Uint8Array, format: 'deflate' | 'gzip' | 'deflate-raw'): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream(format)
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds)
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch { return null }
}

/** Raw bytes, or their zlib/gzip/deflate expansion when they are compressed. */
async function expand(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return (await inflate(bytes, 'gzip')) ?? bytes
  if (bytes[0] === 0x78) { const z = await inflate(bytes, 'deflate'); if (z) return z }
  const raw = await inflate(bytes, 'deflate-raw')
  return raw && raw.length ? raw : bytes
}

const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s }

/** A PDF string literal or hex string value: "(Smoke Detector)" or "<FEFF0053...>". */
function pdfString(raw: string): string {
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '')
    const b = Array.from({ length: Math.floor(hex.length / 2) }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
    if (b[0] === 0xfe && b[1] === 0xff) {
      let s = ''
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1])
      return s
    }
    return String.fromCharCode(...b)
  }
  return raw.slice(1, -1).replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c)
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
}

/** Subject (and fallback title) of the first annotation dictionary found in decoded markup text. */
export function subjectOf(decoded: string): string {
  const m = /\/Subj\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(decoded)
  return m ? pdfString(m[1]).trim() : ''
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IEND = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
function findSeq(b: Uint8Array, seq: number[], from = 0): number {
  outer: for (let i = from; i <= b.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (b[i + j] !== seq[j]) continue outer
    return i
  }
  return -1
}

const toDataUrl = (mime: string, b: Uint8Array) => {
  let bin = ''
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(bin)}`
}

/** First PNG or JPEG embedded in the bytes, as a data URL. */
export function findImage(b: Uint8Array): string | undefined {
  const p = findSeq(b, PNG)
  if (p >= 0) {
    const e = findSeq(b, IEND, p)
    if (e >= 0) return toDataUrl('image/png', b.subarray(p, e + 8))
  }
  if (b[0] === 0xff && b[1] === 0xd8) return toDataUrl('image/jpeg', b)
  return undefined
}

// ---------- Revu 2018+ format: grouped tools (parent annotation + <Child> annotations) ----------

export interface BtxShape {
  kind: 'rect' | 'ellipse' | 'line' | 'poly' | 'text'
  /** Offset of the shape's top-left from the parent's origin, in points (y down). */
  x: number; y: number; w: number; h: number
  fill?: string; stroke?: string
  fillOpacity: number; strokeOpacity: number; strokeWidth: number
  /** line / polygon points relative to (x, y) */
  points?: [number, number][]
  text?: string; fontSize?: number; textColor?: string
}

const num = (s: string | undefined) => (s === undefined ? undefined : Number(s))

/** Value token after /Key in a PDF dict text (number, name, string, array), or undefined. */
function dictRaw(d: string, key: string): string | undefined {
  const m = new RegExp(`/${key}(?![A-Za-z0-9])\\s*(\\((?:\\\\.|[^\\\\)])*\\)|\\[[^\\]]*\\]|<<[^>]*>>|<[0-9A-Fa-f\\s]*>|[^\\s/<>\\[\\](]+)`).exec(d)
  return m?.[1]
}
const dictNums = (d: string, key: string): number[] | undefined => {
  const r = dictRaw(d, key)
  if (!r || !r.startsWith('[')) return undefined
  const a = r.slice(1, -1).trim().split(/\s+/).filter(Boolean).map(Number)
  return a.length && a.every(Number.isFinite) ? a : undefined
}
const dictString = (d: string, key: string): string => {
  const r = dictRaw(d, key)
  return r && (r.startsWith('(') || (r.startsWith('<') && !r.startsWith('<<'))) ? pdfString(r).trim() : ''
}

/** PDF color array (gray, rgb or cmyk, 0-1) to a CSS color, or undefined. */
function cssColor(a: number[] | undefined): string | undefined {
  if (!a) return undefined
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  if (a.length === 1) return `rgb(${c(a[0])},${c(a[0])},${c(a[0])})`
  if (a.length === 3) return `rgb(${c(a[0])},${c(a[1])},${c(a[2])})`
  if (a.length === 4) return `rgb(${c((1 - a[0]) * (1 - a[3]))},${c((1 - a[1]) * (1 - a[3]))},${c((1 - a[2]) * (1 - a[3]))})`
  return undefined
}

/** Plain text of a FreeText annotation: rich text (/RC) paragraphs, else /Contents. */
export function freeTextOf(d: string): string {
  const rc = /\/RC\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(d)
  if (rc) {
    const xml = pdfString(rc[1])
    const paras = [...xml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m => xmlText(m[1].replace(/<[^>]+>/g, '')).trim()).filter(Boolean)
    if (paras.length) return paras.join(' ')
    const body = xmlText(xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<[^>]+>/g, '')).trim()
    if (body) return body
  }
  return dictString(d, 'Contents')
}

const rectOf = (d: string): { w: number; h: number; x0: number; y0: number } => {
  const r = dictNums(d, 'Rect') ?? dictNums(d, 'TempBBox') ?? [0, 0, 0, 0]
  return { x0: r[0], y0: r[1], w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) }
}

/** Turns one annotation dict (+ its offset from the parent) into a drawable shape, or null. */
function shapeOf(d: string, type: string, x: number, y: number): BtxShape | null {
  const sub = (dictRaw(d, 'Subtype') ?? type).replace('/', '').replace(/^.*Annotation/, '')
  const r = rectOf(d)
  const ca = num(dictRaw(d, 'CA')) ?? 1
  const fillOpacity = (num(dictRaw(d, 'FillOpacity')) ?? 1) * ca
  const bs = dictRaw(d, 'BS')
  const strokeWidth = bs ? Number(/\/W\s+([\d.]+)/.exec(bs)?.[1] ?? 1) : 1
  const base = { x, y, w: r.w, h: r.h, fill: cssColor(dictNums(d, 'IC')), stroke: cssColor(dictNums(d, 'C')), fillOpacity, strokeOpacity: ca, strokeWidth }
  if (sub === 'Square') return { kind: 'rect', ...base }
  if (sub === 'Circle') return { kind: 'ellipse', ...base }
  if (sub === 'Line') {
    const L = dictNums(d, 'L')
    const pts: [number, number][] = L && L.length >= 4
      ? [[L[0] - r.x0, r.h - (L[1] - r.y0)], [L[2] - r.x0, r.h - (L[3] - r.y0)]]
      : [[0, r.h], [r.w, 0]]
    return { kind: 'line', ...base, fill: undefined, points: pts }
  }
  if (sub === 'Polygon' || sub === 'PolyLine') {
    const v = dictNums(d, 'Vertices')
    if (!v || v.length < 4) return null
    const pts: [number, number][] = []
    for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i] - r.x0, r.h - (v[i + 1] - r.y0)])
    return { kind: 'poly', ...base, fill: sub === 'Polygon' ? base.fill : undefined, points: pts }
  }
  if (sub === 'FreeText') {
    const text = freeTextOf(d)
    if (!text) return null
    const da = dictString(d, 'DA')
    const fs = Number(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? 9)
    const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da)
    const hex = /color:\s*(#[0-9a-fA-F]{6})/.exec(dictString(d, 'DS'))
    return { kind: 'text', ...base, fill: undefined, stroke: undefined, text, fontSize: fs || 9, textColor: hex?.[1] ?? (rgb ? cssColor([+rgb[1], +rgb[2], +rgb[3]]) : '#000000') }
  }
  return null
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n2 = (v: number) => String(Math.round(v * 100) / 100)

/** Draws the group as an SVG document string. Returns '' when there is nothing to draw. */
export function shapesToSvg(shapes: BtxShape[]): string {
  if (!shapes.length) return ''
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of shapes) {
    const pad = s.stroke ? s.strokeWidth / 2 : 0
    x0 = Math.min(x0, s.x - pad); y0 = Math.min(y0, s.y - pad); x1 = Math.max(x1, s.x + s.w + pad); y1 = Math.max(y1, s.y + s.h + pad)
  }
  const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0)
  const body = shapes.map(s => {
    const x = s.x - x0, y = s.y - y0
    const paint = `fill="${s.fill ?? 'none'}" fill-opacity="${n2(s.fillOpacity)}" stroke="${s.stroke && s.strokeWidth > 0 ? s.stroke : 'none'}" stroke-opacity="${n2(s.strokeOpacity)}" stroke-width="${n2(s.strokeWidth)}"`
    if (s.kind === 'rect') return `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(s.w)}" height="${n2(s.h)}" ${paint}/>`
    if (s.kind === 'ellipse') return `<ellipse cx="${n2(x + s.w / 2)}" cy="${n2(y + s.h / 2)}" rx="${n2(s.w / 2)}" ry="${n2(s.h / 2)}" ${paint}/>`
    const pts = (s.points ?? []).map(([px, py]) => `${n2(x + px)},${n2(y + py)}`).join(' ')
    if (s.kind === 'line') return `<polyline points="${pts}" ${paint} fill="none"/>`
    if (s.kind === 'poly') return `<polygon points="${pts}" ${paint}/>`
    return `<text x="${n2(x + s.w / 2)}" y="${n2(y + s.h / 2)}" font-family="Helvetica, Arial, sans-serif" font-size="${n2(s.fontSize ?? 9)}" fill="${s.textColor ?? '#000'}" text-anchor="middle" dominant-baseline="central">${esc(s.text ?? '')}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n2(W)} ${n2(H)}" width="${n2(W)}" height="${n2(H)}">${body}</svg>`
}

export function svgToDataUrl(svg: string): string {
  const b = new TextEncoder().encode(svg)
  let bin = ''
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return `data:image/svg+xml;base64,${btoa(bin)}`
}

/** Hex of zlib-deflated text (as used for <Title> and <Raw>) back to a latin1 string; null when not that. */
async function hexInflate(hex: string): Promise<string | null> {
  const bytes = bytesFromEncoded(hex)
  if (!bytes) return null
  const out = await inflate(bytes, 'deflate')
  return out ? latin1(out) : null
}

/** Real tool name from /TempGroupNesting[(model - description)/ID/...]. */
export function groupNameOf(d: string): string {
  const m = /\/TempGroupNesting\s*\[\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(d)
  return m ? pdfString(m[1]).trim() : ''
}

/** Splits "IR421P5 - Single Patient Station" into model and description. */
export function splitName(full: string): { model: string; description: string } {
  const i = full.indexOf(' - ')
  if (i > 0) return { model: full.slice(0, i).trim(), description: full.slice(i + 3).trim() || full.slice(0, i).trim() }
  return { model: '', description: full.trim() }
}

export interface BtxSet { title: string; tools: BtxTool[] }

/** Reads a whole tool set: its (decoded) title plus tools. */
export async function parseBtxSet(xml: string): Promise<BtxSet> {
  const tools = await parseBtx(xml)
  const t = /<Title>\s*([^<]*?)\s*<\/Title>/.exec(xml)
  let title = t ? xmlText(t[1]) : ''
  if (title) {
    const dec = await hexInflate(title)
    if (dec !== null) {
      try { title = new TextDecoder().decode(Uint8Array.from(dec, c => c.charCodeAt(0) & 255)) } catch { title = dec }
    }
  }
  return { title: title.trim(), tools }
}

const tagVal = (s: string, tag: string) => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(s)?.[1]

/** One grouped tool; null unless some annotation of the group carries a /TempGroupNesting name. */
async function parseGrouped(it: El): Promise<BtxTool | null> {
  const firstChild = it.inner.indexOf('<Child')
  const head = firstChild < 0 ? it.inner : it.inner.slice(0, firstChild)
  const parts = [head, ...(firstChild < 0 ? [] : elements(it.inner.slice(firstChild), ['Child']).map(c => c.inner))]
  const dicts: { d: string; type: string; x: number; y: number }[] = []
  for (const p of parts) {
    const h = tagVal(p, 'Raw')
    const d = h ? await hexInflate(h) : null
    if (d) dicts.push({ d, type: tagVal(p, 'Type') ?? '', x: -(Number(tagVal(p, 'X') ?? 0) || 0), y: -(Number(tagVal(p, 'Y') ?? 0) || 0) })
  }
  let group = dicts.map(x => groupNameOf(x.d)).find(Boolean) ?? ''
  // single ungrouped annotation (e.g. a text box) whose <Name> is just a random id: use its Subject
  if (!group && dicts.length && /^[A-Z]{16}$/.test(tagVal(head, 'Name') ?? '')) group = subjectOf(dicts[0].d)
  if (!group) return null
  const shapes: BtxShape[] = []
  let label = ''
  for (const x of dicts) {
    if (/\/Image\b/.test(x.d)) continue // raster stamp: not drawn
    const sh = shapeOf(x.d, x.type, x.x, x.y)
    if (sh) { shapes.push(sh); if (sh.kind === 'text' && !label) label = sh.text ?? '' }
  }
  const { model, description } = splitName(group)
  const svg = shapesToSvg(shapes)
  return {
    title: description, subject: subjectOf(dicts[0].d), decoded: true, name: description, model, label,
    layer: dicts.map(x => dictString(x.d, 'OC')).find(Boolean) ?? '',
    svg: svg || undefined, icon: svg ? svgToDataUrl(svg) : undefined,
  }
}

/** Reads the tools of a .btx file's text. Never throws; returns [] when no tool items are recognised. */
export async function parseBtx(xml: string): Promise<BtxTool[]> {
  const items = elements(xml, ITEM_TAGS).filter(e => e.inner.trim().length > 0)
  // Item/Tool also match wrapper tags; keep only elements that don't contain another matching item
  const leaf = items.filter(e => elements(e.inner, ITEM_TAGS).length === 0)
  const out: BtxTool[] = []
  for (const it of leaf) {
    try {
      if (it.tag === 'ToolChestItem' && it.inner.includes('<Raw>')) {
        const g = await parseGrouped(it)
        if (g) { out.push(g); continue }
      }
    } catch { /* fall back to the legacy reader */ }
    let subject = '', icon: string | undefined, decoded = false
    for (const c of children(it.inner)) {
      if (TITLE_TAGS.includes(c.tag)) continue
      const body = xmlText(c.inner.replace(/<[^>]+>/g, ''))
      const bytes = bytesFromEncoded(body)
      if (!bytes) continue
      const data = await expand(bytes)
      const asText = latin1(data)
      if (!subject) { const s = subjectOf(asText); if (s) { subject = s; decoded = true } }
      if (!icon && (ICON_TAGS.includes(c.tag) || findSeq(data, PNG) >= 0)) icon = findImage(data)
    }
    const title = it.attrs.Name || it.attrs.Title || childText(it.inner, TITLE_TAGS) || subject
    if (!title) continue
    out.push({ title, subject, icon, decoded })
  }
  return out
}

/** Reads a .btx File. */
export async function readBtxFile(file: File): Promise<BtxTool[]> {
  return parseBtx(await file.text())
}

/** Builds a synthetic .btx string (used by tests and as documentation of the layout we expect). */
export async function makeSyntheticBtx(tools: { title: string; subject: string; png?: Uint8Array }[]): Promise<string> {
  const enc = new TextEncoder()
  const items: string[] = []
  for (const t of tools) {
    const dict = enc.encode(`<</Type/Annot/Subtype/Square/Subj(${t.subject})/C[1 0 0]>>`)
    const cs = new Blob([dict as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
    const z = new Uint8Array(await new Response(cs).arrayBuffer())
    const hex = Array.from(z, b => b.toString(16).padStart(2, '0')).join('')
    const img = t.png ? `<Image>${btoa(String.fromCharCode(...t.png))}</Image>` : ''
    items.push(`<ToolChestItem Version="1"><Name>${t.title}</Name><Raw>${hex}</Raw>${img}</ToolChestItem>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?><BluebeamRevuToolSet Version="1">${items.join('')}</BluebeamRevuToolSet>`
}
