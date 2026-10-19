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

/** Reads the tools of a .btx file's text. Never throws; returns [] when no tool items are recognised. */
export async function parseBtx(xml: string): Promise<BtxTool[]> {
  const items = elements(xml, ITEM_TAGS).filter(e => e.inner.trim().length > 0)
  // Item/Tool also match wrapper tags; keep only elements that don't contain another matching item
  const leaf = items.filter(e => elements(e.inner, ITEM_TAGS).length === 0)
  const out: BtxTool[] = []
  for (const it of leaf) {
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
