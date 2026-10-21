// Device classes with two built-in icon options each. Option A follows the drafting symbols used in the Revu tool sets
// (a letter code or the device's own glyph, camera body). Option B is the common pictorial industry alternative.
//
// Drawing rules (same as library.ts):
//  - 24x24 viewBox, stroke based: stroke-width 1.8, round caps and joins, colour = currentColor.
//  - NO outer container. The app draws the container (circle = ceiling, "D" = wall, rounded square = square) in the
//    category colour and puts the icon inside it, so an icon must not draw its own circle, square or triangle around itself.
//  - Keep all artwork inside the safe area x, y in [3, 21] (an 18x18 square centred in the box). That square fits inside
//    all three container shapes, at any wall facing, with room for the container's outline.
//  - Letter codes are 1 to 3 letters (see T below) and are scaled to fit the safe area.
import { iconDataUrl } from './library'
import type { IconCategory, IconDef } from './library'

export interface IconClass {
  id: string
  name: string
  category: IconCategory
  /** Matches a lower-cased tool / device name. Earlier classes win. */
  match: RegExp
  a: IconDef
  b: IconDef
}

// Option B only: a few pictorial icons carry their own outline body (a lone circle is a lens/dome, not a container)
const C = '<circle cx="12" cy="12" r="9"/>'
const SQ = '<rect x="3" y="3" width="18" height="18" rx="1.5"/>'
const dot = (x: number, y: number, r = 1.3) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`
// Letter glyphs: stroke paths in a 6 wide x 9 tall box centred on (0,0), absolute M / L / C commands only.
const GLYPHS: Record<string, string> = {
  A: 'M-3 4.5 L0 -4.5 L3 4.5 M-1.6 1 L1.6 1',
  B: 'M-3 -4.5 L-3 4.5 M-3 -4.5 L0.4 -4.5 C3 -4.5 3 -0.2 0.4 -0.2 L-3 -0.2 M0.4 -0.2 C3.6 -0.2 3.6 4.5 0.4 4.5 L-3 4.5',
  C: 'M3 -2.6 C1 -5.4 -3 -4.2 -3 0 C-3 4.2 1 5.4 3 2.6',
  D: 'M-3 -4.5 L-3 4.5 L-0.5 4.5 C3.6 4.5 3.6 -4.5 -0.5 -4.5 L-3 -4.5',
  E: 'M3 -4.5 L-3 -4.5 L-3 4.5 L3 4.5 M-3 0 L2 0',
  F: 'M3 -4.5 L-3 -4.5 L-3 4.5 M-3 0 L2 0',
  G: 'M3 -2.6 C1 -5.4 -3 -4.2 -3 0 C-3 4.2 1 5.4 3 2.6 L3 0.3 L0.5 0.3',
  H: 'M-3 -4.5 L-3 4.5 M3 -4.5 L3 4.5 M-3 0 L3 0',
  I: 'M-2 -4.5 L2 -4.5 M0 -4.5 L0 4.5 M-2 4.5 L2 4.5',
  J: 'M3 -4.5 L3 2 C3 5.8 -3 5.8 -3 2',
  K: 'M-3 -4.5 L-3 4.5 M3 -4.5 L-3 1.5 M-0.5 -0.8 L3 4.5',
  L: 'M-3 -4.5 L-3 4.5 L3 4.5',
  M: 'M-3 4.5 L-3 -4.5 L0 0.5 L3 -4.5 L3 4.5',
  N: 'M-3 4.5 L-3 -4.5 L3 4.5 L3 -4.5',
  O: 'M0 -4.5 C-4.0 -4.5 -4.0 4.5 0 4.5 C4.0 4.5 4.0 -4.5 0 -4.5',
  P: 'M-3 4.5 L-3 -4.5 L0.4 -4.5 C3.6 -4.5 3.6 0.5 0.4 0.5 L-3 0.5',
  Q: 'M0 -4.5 C-4.0 -4.5 -4.0 4.5 0 4.5 C4.0 4.5 4.0 -4.5 0 -4.5 M1 2 L3.2 5',
  R: 'M-3 4.5 L-3 -4.5 L0.4 -4.5 C3.6 -4.5 3.6 0.5 0.4 0.5 L-3 0.5 M0.4 0.5 L3 4.5',
  S: 'M3 -3 C2 -5.2 -3 -5.2 -3 -2 C-3 0.6 3 -0.6 3 2.4 C3 5.6 -2 5.2 -3 3',
  T: 'M-3 -4.5 L3 -4.5 M0 -4.5 L0 4.5',
  U: 'M-3 -4.5 L-3 1.5 C-3 6.2 3 6.2 3 1.5 L3 -4.5',
  V: 'M-3 -4.5 L0 4.5 L3 -4.5',
  W: 'M-3.2 -4.5 L-1.6 4.5 L0 -1 L1.6 4.5 L3.2 -4.5',
  X: 'M-3 -4.5 L3 4.5 M3 -4.5 L-3 4.5',
  Y: 'M-3 -4.5 L0 0 L3 -4.5 M0 0 L0 4.5',
  Z: 'M-3 -4.5 L3 -4.5 L-3 4.5 L3 4.5',
}
const fmt = (n: number) => String(Math.round(n * 100) / 100)
/** Scale + shift every coordinate pair of a glyph path (stroke width is not scaled, so it stays 1.8). */
const place = (d: string, s: number, ox: number, oy: number) => d.replace(/(-?[0-9.]+) (-?[0-9.]+)/g, (_m, x, y) => `${fmt(ox + x * s)} ${fmt(oy + y * s)}`)
/**
 * A letter code of 1 to 3 letters (A-Z), centred on (12,12) and scaled to fit the safe area:
 * 1 letter 11.3 tall, 2 letters 9.5 tall, 3 letters 6.8 tall (about 17 wide).
 */
export function T(text: string): string {
  const letters = [...text.toUpperCase()].filter(ch => GLYPHS[ch]).slice(0, 3)
  if (!letters.length) return ''
  const s = [0, 1.25, 1.05, 0.75][letters.length]
  const step = (6 + 2) * s // glyph box + gap
  const x0 = 12 - ((letters.length - 1) * step) / 2
  return letters.map((ch, i) => `<path d="${place(GLYPHS[ch], s, x0 + i * step, 12)}"/>`).join('')
}

const mk = (id: string, name: string, category: IconCategory, keywords: string, body: string): IconDef => ({ id, name, category, keywords, body })
const cls = (id: string, name: string, category: IconCategory, match: RegExp, a: string, b: string): IconClass => ({
  id, name, category, match,
  a: mk(`${id}-a`, `${name} (A)`, category, `${name} option a revu`, a),
  b: mk(`${id}-b`, `${name} (B)`, category, `${name} option b standard`, b),
})

export const ICON_CLASSES: IconClass[] = [
  // ---- Video
  cls('cam-ptz', 'PTZ camera', 'Video', /\bptz\b|pan.?tilt/,
    '<rect x="4" y="7" width="12" height="8" rx="1.5"/><path d="M16 9.5l5-2.5v10l-5-2.5M10 15v4M6 19h8"/><path d="M3.5 3.5l2 2M20.5 3.5l-2 2"/>',
    '<circle cx="12" cy="10" r="5.5"/><circle cx="12" cy="10" r="2" fill="currentColor"/><path d="M8.5 17.5h7M12 15.5v2M9 21h6M2.5 10l2-2M2.5 10l2 2M21.5 10l-2-2M21.5 10l-2 2"/>'),
  cls('cam-fisheye', 'Fisheye / panoramic camera', 'Video', /fish.?eye|360|180 degree|panoramic/,
    '<path d="M3 17a9 9 0 0 1 18 0z"/><path d="M6 17a6 6 0 0 1 12 0"/>' + dot(12, 13.5, 1.5),
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/>'),
  cls('cam-multi', 'Multi-sensor camera', 'Video', /multi.?sensor|multi.?imager/,
    dot(7.5, 14, 1.8) + dot(12, 10, 1.8) + dot(16.5, 14, 1.8),
    '<path d="M3 18a9 9 0 0 1 18 0z"/>' + dot(8, 14, 1.6) + dot(12, 11.5, 1.6) + dot(16, 14, 1.6)),
  cls('cam-dome', 'Dome camera', 'Video', /dome|turret|eyeball|indoor camera|ceiling camera|megapixel/,
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v2M12 19v2"/>',
    '<path d="M3 17a9 9 0 0 1 18 0z"/><circle cx="12" cy="13" r="2.4" fill="currentColor"/><path d="M2 20.5h20"/>'),
  cls('cam-bullet', 'Bullet / fixed camera', 'Video', /camera|bullet|cctv|lpr/,
    '<rect x="3" y="8" width="14" height="8" rx="1.5"/><path d="M17 10.5L21 8v8l-4-2.5M3 4l3 2"/>',
    '<rect x="3" y="9" width="13" height="6" rx="1.5"/><path d="M16 11l5-2v6l-5-2M7 15v3M4 18h6"/>'),
  cls('video-nvr', 'NVR / recorder', 'Video', /\bnvr\b|\bdvr\b|video recorder/,
    '<rect x="3" y="7" width="18" height="10" rx="1.5"/><circle cx="8" cy="12" r="2" fill="currentColor"/><path d="M13 10h5M13 14h5"/>',
    '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M6.5 12h6"/><circle cx="17" cy="12" r="1.2" fill="currentColor"/>'),
  cls('video-monitor', 'Monitor / display', 'Video', /monitor|display|screen/,
    '<rect x="3" y="5" width="18" height="12" rx="1"/><path d="M3 5l18 12"/>',
    '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),

  // ---- Fire alarm
  cls('fa-co', 'CO detector', 'Fire alarm', /carbon mon|\bco\b|smoke.?\/?co/,
    T('CO'),
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="5"/><path d="M10.5 10.5a2 2 0 1 0 0 3"/><circle cx="14" cy="12" r="1.3"/>'),
  cls('fa-duct', 'Duct detector', 'Fire alarm', /duct/,
    '<rect x="3" y="10" width="18" height="9" rx="1"/><path d="M8 10V6h8v4M12 6V3"/>',
    '<path d="M2 15h20M2 21h20"/><rect x="8" y="4" width="8" height="6" rx="1"/><path d="M12 10v5"/>'),
  cls('fa-smoke', 'Smoke detector', 'Fire alarm', /smoke|fire address|detector with sounder/,
    T('S'),
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'),
  cls('fa-heat', 'Heat detector', 'Fire alarm', /heat|thermal|rate.of.rise/,
    T('H'),
    '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v7"/><circle cx="12" cy="16" r="1.8" fill="currentColor"/>'),
  cls('fa-pull', 'Pull station', 'Fire alarm', /pull station|fire service or emergency|remote test switch/,
    T('PS'),
    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7.5h6"/><rect x="9" y="12" width="6" height="5" rx="1" fill="currentColor"/>'),
  cls('fa-speaker-strobe', 'Speaker / strobe', 'Fire alarm', /speaker.?(\/|-)?\s?strobe/,
    '<rect x="3" y="6" width="18" height="12" rx="1.5"/><circle cx="8.5" cy="12" r="2.5"/><path d="M14 12h5"/>',
    '<path d="M2.5 9v6h3l4 3V6l-4 3z"/><circle cx="16.5" cy="12" r="2.2" fill="currentColor"/><path d="M16.5 6v2M16.5 16v2M21.5 12h-1M20 7.8l-1.4 1.4M20 16.2l-1.4-1.4"/>'),
  cls('fa-horn-strobe', 'Horn / strobe', 'Fire alarm', /horn|sounder/,
    '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M7 10v4M12 10v4M7 12h5M16 10h2"/>',
    '<path d="M3 10v4h4l5 4V6L7 10z"/><path d="M16 8l3-2M17 12h4M16 16l3 2"/>'),
  cls('fa-strobe', 'Strobe', 'Fire alarm', /strobe/,
    '<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/>',
    '<circle cx="12" cy="12" r="3.5" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2"/>'),
  cls('fa-module', 'Monitor / addressable module', 'Fire alarm', /\bmodule\b|relay|web relay/,
    T('MM'),
    '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 14V10l2.5 3L12 10v4M16 10v4"/>'),
  cls('fa-flow', 'Water flow / tamper switch', 'Fire alarm', /water ?flow|flow switch|tamper|supervisory/,
    T('FS'),
    '<path d="M2 16h20M2 21h20"/><path d="M12 16V9"/><rect x="8.5" y="4" width="7" height="5" rx="1"/>'),
  cls('fa-annunciator', 'Annunciator', 'Fire alarm', /annunciator/,
    '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18"/>' + dot(8, 14.5, 1.2) + dot(12, 14.5, 1.2) + dot(16, 14.5, 1.2),
    '<rect x="3" y="5" width="18" height="14" rx="2"/>' + dot(8, 10, 1.2) + dot(12, 10, 1.2) + dot(16, 10, 1.2) + '<path d="M7 15h10"/>'),
  cls('fa-facp', 'Fire alarm panel / power', 'Fire alarm', /fire alarm panel|facp|\bnac\b|power supply|booster|alarm communicator/,
    '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M8 15h8"/>',
    '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="12" height="4"/><path d="M7 14h2M11 14h2M15 14h2M7 17.5h2M11 17.5h2M15 17.5h2"/>'),

  // ---- Access
  cls('ac-rex', 'Request to exit (REX)', 'Access', /request to exit|\brex\b|exit button|touchless/,
    T('REX'),
    '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  cls('ac-maglock', 'Mag lock', 'Access', /mag.?lock|magnetic lock|door holder/,
    T('ML'),
    '<rect x="2" y="5" width="20" height="6" rx="1"/><rect x="2" y="13" width="20" height="6" rx="1"/><path d="M12 11v2"/>'),
  cls('ac-strike', 'Electric strike / door lock', 'Access', /strike|door lock|lock repeater/,
    '<path d="M8 5h8v14H8z"/><path d="M8 9.5h4v5H8z"/>',
    '<rect x="7" y="2" width="10" height="20" rx="1"/><rect x="10" y="8" width="7" height="5" fill="currentColor"/>'),
  cls('ac-contact', 'Door / window contact', 'Access', /contact|door sensor|window sensor|door position|\bdps\b/,
    '<rect x="3" y="9" width="7" height="6" rx="1"/><rect x="14" y="9" width="7" height="6" rx="1"/><path d="M10.5 12h3"/>',
    C + '<path d="M7 12h3M14 12h3"/>'),
  cls('ac-keypad', 'Keypad', 'Access', /keypad/,
    '<rect x="6" y="3" width="12" height="18" rx="2"/>' + dot(9, 7) + dot(12, 7) + dot(15, 7) + dot(9, 10.5) + dot(12, 10.5) + dot(15, 10.5) + dot(9, 14) + dot(12, 14) + dot(15, 14) + dot(12, 17.5),
    SQ + T('K')),
  cls('ac-reader', 'Card reader', 'Access', /card ?reader|cardereader|reader|badge|prewire for access|^access control$/,
    '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9.5 12a3.5 3.5 0 0 1 5 0M8 9.8a6 6 0 0 1 8 0"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/>',
    SQ + '<path d="M8 15.5a5 5 0 0 1 8 0M10 13.5a2.5 2.5 0 0 1 4 0"/>' + dot(12, 17.5, 1)),
  cls('ac-panel', 'Access / alarm panel', 'Access', /access control panel|alarm panel|controller/,
    '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M8 14h8"/>',
    '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="11" width="8" height="6" rx="1"/><path d="M9.5 11V9a2.5 2.5 0 0 1 5 0v2"/>'),

  // ---- Intrusion
  cls('in-glass', 'Glass break', 'Intrusion', /glass.?break/,
    T('GB'),
    '<rect x="5" y="3" width="14" height="18"/><path d="M12 6l-2 5 3 1-2 6"/>'),
  cls('in-pir', 'Motion detector (PIR)', 'Intrusion', /motion|\bpir\b|occupancy/,
    '<path d="M6 17.5l6-11 6 11z"/>',
    '<circle cx="12" cy="7" r="4"/><path d="M5 15c4 3 10 3 14 0M7 19.5c3 2 7 2 10 0"/>'),
  cls('in-siren', 'Siren', 'Intrusion', /siren/,
    '<path d="M6 17v-3.5a6 6 0 0 1 12 0V17zM12 4.5v1.5"/>',
    '<path d="M5 18v-5a7 7 0 0 1 14 0v5z"/><path d="M3 21h18M12 3v2M4.5 6l1.5 1.5M19.5 6L18 7.5"/>'),

  // ---- Network
  cls('net-wap', 'Wireless access point', 'Network', /access point|\bwap\b|wi.?fi|wireless access/,
    T('WAP'),
    '<circle cx="12" cy="18" r="2" fill="currentColor"/><path d="M8 14.2a5.7 5.7 0 0 1 8 0M4.8 10.6a10.4 10.4 0 0 1 14.4 0M1.8 7.2a14.5 14.5 0 0 1 20.4 0"/>'),
  cls('net-jack', 'Data / telephone jack', 'Network', /data jack|jack|telephone|\btel\b|lv data|data box|lv phone|tv ?(&|and)? ?data/,
    T('DJ'),
    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 9h7v6h-2v1.5h-3V15h-2z"/>'),
  cls('net-switch', 'Switch / rack / MDF', 'Network', /network switch|^switch$|\brack\b|\bmdf\b|\bidf\b|point to point|\bhdmi\b/,
    '<rect x="3" y="6" width="18" height="12" rx="1.5"/>' + dot(7, 12, 1) + dot(10.5, 12, 1) + dot(14, 12, 1) + dot(17.5, 12, 1),
    '<rect x="5" y="2" width="14" height="20" rx="1"/><path d="M5 7h14M5 12h14M5 17h14"/>'),

  // ---- AV / Paging
  cls('av-intercom', 'Intercom / station', 'AV / Paging', /intercom|door station|indoor station|master station|patient station|duty station|pull-cord/,
    '<path d="M6 8h12M6 12h12M6 16h8"/>',
    '<rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="7" r="2"/><path d="M9 12h6M9 15h6"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>'),
  cls('av-speaker', 'Speaker', 'AV / Paging', /speaker|\bsip\b|talkback|analog|mic jack/,
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>',
    '<path d="M3 10v4h4l6 4.5v-13L7 10z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),

  // ---- Power
  cls('pw-outlet', 'Outlet', 'Power', /outlet|receptacle|\bgfi\b/,
    '<path d="M8.5 6v5.5M15.5 6v5.5M12 14.5V18"/>',
    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9.5 8v3M14.5 8v3"/><circle cx="12" cy="16" r="1.4"/>'),
]

/** Every option, for searching alongside the main library. */
export const CLASS_ICONS: IconDef[] = ICON_CLASSES.flatMap(c => [c.a, c.b])

/** The class a Revu tool / device name belongs to, if it is recognised. */
export function classForName(name: string): IconClass | undefined {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim()
  return n ? ICON_CLASSES.find(c => c.match.test(n)) : undefined
}

/** Option A (the Revu-style drawing) as a stored data URL, or undefined for an unrecognised name. */
export function autoIconFor(name: string, color = '#ffffff'): string | undefined {
  const c = classForName(name)
  return c ? iconDataUrl(c.a, color) : undefined
}
