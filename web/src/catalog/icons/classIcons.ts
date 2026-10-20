// Device classes with two built-in icon options each. Option A follows the drafting symbols used in the Revu tool sets
// (circle/square/triangle with a letter, camera body). Option B is the common pictorial industry alternative.
// Same drawing rules as library.ts: 24x24, stroke based, currentColor.
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

const C = '<circle cx="12" cy="12" r="9"/>'
const SQ = '<rect x="3" y="3" width="18" height="18" rx="1.5"/>'
const TRI = '<path d="M12 3.5l9 16H3z"/>'
const dot = (x: number, y: number, r = 1.3) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`
// Block letters drawn as strokes, centred near (12,12)
const L = {
  S: '<path d="M15 9.2c-.6-1.2-5.4-1.4-5.4.9 0 2.6 5.4 1.2 5.4 3.8 0 2.2-4.8 2-5.4.8"/>',
  H: '<path d="M9.5 8.5v7M14.5 8.5v7M9.5 12h5"/>',
  P: '<path d="M10 16V8.5h3a2 2 0 0 1 0 4.5h-3"/>',
  M: '<path d="M8.5 16V8.5l3.5 4.5 3.5-4.5V16"/>',
  C: '<path d="M15 9.5a3.5 3.5 0 1 0 0 5"/>',
  R: '<path d="M10 16V8.5h3a2 2 0 0 1 0 4.5h-3M13 13l2.5 3"/>',
  K: '<path d="M10 8.5V16M10 12.5l4.5-4M11.5 11.5L15 16"/>',
  G: '<path d="M15 9.5a3.5 3.5 0 1 0 0 5v-2h-2"/>',
  W: '<path d="M7.5 8.5l2 7.5 2.5-5.5 2.5 5.5 2-7.5"/>',
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
    '<rect x="4" y="7" width="12" height="8" rx="1.5"/><path d="M16 9.5l5-2.5v10l-5-2.5M10 15v4M6 19h8"/><path d="M2 3l2 2M22 3l-2 2"/>',
    '<circle cx="12" cy="10" r="5.5"/><circle cx="12" cy="10" r="2" fill="currentColor"/><path d="M8.5 17.5h7M12 15.5v2M9 21h6M2.5 10l2-2M2.5 10l2 2M21.5 10l-2-2M21.5 10l-2 2"/>'),
  cls('cam-fisheye', 'Fisheye / panoramic camera', 'Video', /fish.?eye|360|180 degree|panoramic/,
    '<path d="M3 17a9 9 0 0 1 18 0z"/><path d="M6 17a6 6 0 0 1 12 0"/>' + dot(12, 13.5, 1.5),
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/>'),
  cls('cam-multi', 'Multi-sensor camera', 'Video', /multi.?sensor|multi.?imager/,
    C + dot(8, 13, 1.6) + dot(12, 10.5, 1.6) + dot(16, 13, 1.6),
    '<path d="M3 18a9 9 0 0 1 18 0z"/>' + dot(8, 14, 1.6) + dot(12, 11.5, 1.6) + dot(16, 14, 1.6)),
  cls('cam-dome', 'Dome camera', 'Video', /dome|turret|eyeball|indoor camera|ceiling camera|megapixel/,
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3"/>',
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
    C + L.C,
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="5"/><path d="M10.5 10.5a2 2 0 1 0 0 3"/><circle cx="14" cy="12" r="1.3"/>'),
  cls('fa-duct', 'Duct detector', 'Fire alarm', /duct/,
    '<rect x="2" y="9" width="20" height="9" rx="1"/><path d="M8 9V5h8v4M12 5V2"/>',
    '<path d="M2 15h20M2 21h20"/><rect x="8" y="4" width="8" height="6" rx="1"/><path d="M12 10v5"/>'),
  cls('fa-smoke', 'Smoke detector', 'Fire alarm', /smoke|fire address|detector with sounder/,
    C + L.S,
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'),
  cls('fa-heat', 'Heat detector', 'Fire alarm', /heat|thermal|rate.of.rise/,
    C + L.H,
    '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v7"/><circle cx="12" cy="16" r="1.8" fill="currentColor"/>'),
  cls('fa-pull', 'Pull station', 'Fire alarm', /pull station|fire service or emergency|remote test switch/,
    SQ + L.P,
    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7.5h6"/><rect x="9" y="12" width="6" height="5" rx="1" fill="currentColor"/>'),
  cls('fa-speaker-strobe', 'Speaker / strobe', 'Fire alarm', /speaker.?(\/|-)?\s?strobe/,
    '<rect x="3" y="6" width="18" height="12" rx="1.5"/><circle cx="8.5" cy="12" r="2.5"/><path d="M14 12h5"/>',
    '<path d="M2.5 9v6h3l4 3V6l-4 3z"/><circle cx="16.5" cy="12" r="2.2" fill="currentColor"/><path d="M16.5 6v2M16.5 16v2M21.5 12h-1M20 7.8l-1.4 1.4M20 16.2l-1.4-1.4"/>'),
  cls('fa-horn-strobe', 'Horn / strobe', 'Fire alarm', /horn|sounder/,
    '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M7 10v4M12 10v4M7 12h5M16 10h2"/>',
    '<path d="M3 10v4h4l5 4V6L7 10z"/><path d="M16 8l3-2M17 12h4M16 16l3 2"/>'),
  cls('fa-strobe', 'Strobe', 'Fire alarm', /strobe/,
    SQ + '<circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 6v1.5M12 16.5V18M6 12h1.5M16.5 12H18"/>',
    '<circle cx="12" cy="12" r="3.5" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2"/>'),
  cls('fa-module', 'Monitor / addressable module', 'Fire alarm', /\bmodule\b|relay|web relay/,
    '<rect x="3" y="5" width="18" height="14" rx="1.5"/>' + L.M,
    '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 14V10l2.5 3L12 10v4M16 10v4"/>'),
  cls('fa-flow', 'Water flow / tamper switch', 'Fire alarm', /water ?flow|flow switch|tamper|supervisory/,
    TRI + '<path d="M12 9v4"/>',
    '<path d="M2 16h20M2 21h20"/><path d="M12 16V9"/><rect x="8.5" y="4" width="7" height="5" rx="1"/>'),
  cls('fa-annunciator', 'Annunciator', 'Fire alarm', /annunciator/,
    '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18"/>' + dot(8, 14.5, 1.2) + dot(12, 14.5, 1.2) + dot(16, 14.5, 1.2),
    '<rect x="3" y="5" width="18" height="14" rx="2"/>' + dot(8, 10, 1.2) + dot(12, 10, 1.2) + dot(16, 10, 1.2) + '<path d="M7 15h10"/>'),
  cls('fa-facp', 'Fire alarm panel / power', 'Fire alarm', /fire alarm panel|facp|\bnac\b|power supply|booster|alarm communicator/,
    '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M8 15h8"/>',
    '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="12" height="4"/><path d="M7 14h2M11 14h2M15 14h2M7 17.5h2M11 17.5h2M15 17.5h2"/>'),

  // ---- Access
  cls('ac-rex', 'Request to exit (REX)', 'Access', /request to exit|\brex\b|exit button|touchless/,
    SQ + L.R,
    '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  cls('ac-maglock', 'Mag lock', 'Access', /mag.?lock|magnetic lock|door holder/,
    SQ + L.M,
    '<rect x="2" y="5" width="20" height="6" rx="1"/><rect x="2" y="13" width="20" height="6" rx="1"/><path d="M12 11v2"/>'),
  cls('ac-strike', 'Electric strike / door lock', 'Access', /strike|door lock|lock repeater/,
    SQ + '<path d="M9 8h6v8H9z"/>',
    '<rect x="7" y="2" width="10" height="20" rx="1"/><rect x="10" y="8" width="7" height="5" fill="currentColor"/>'),
  cls('ac-contact', 'Door / window contact', 'Access', /contact|door sensor|window sensor|door position|\bdps\b/,
    '<rect x="2" y="9" width="8" height="6" rx="1"/><rect x="14" y="9" width="8" height="6" rx="1"/><path d="M11 12h2"/>',
    C + '<path d="M7 12h3M14 12h3"/>'),
  cls('ac-keypad', 'Keypad', 'Access', /keypad/,
    '<rect x="6" y="2" width="12" height="20" rx="2"/>' + dot(9, 7) + dot(12, 7) + dot(15, 7) + dot(9, 11) + dot(12, 11) + dot(15, 11) + dot(9, 15) + dot(12, 15) + dot(15, 15) + dot(12, 19),
    SQ + L.K),
  cls('ac-reader', 'Card reader', 'Access', /card ?reader|cardereader|reader|badge|prewire for access|^access control$/,
    '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M9.5 12a3.5 3.5 0 0 1 5 0M8 9.8a6 6 0 0 1 8 0"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>',
    SQ + '<path d="M8 15.5a5 5 0 0 1 8 0M10 13.5a2.5 2.5 0 0 1 4 0"/>' + dot(12, 17.5, 1)),
  cls('ac-panel', 'Access / alarm panel', 'Access', /access control panel|alarm panel|controller/,
    '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M8 14h8"/>',
    '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="11" width="8" height="6" rx="1"/><path d="M9.5 11V9a2.5 2.5 0 0 1 5 0v2"/>'),

  // ---- Intrusion
  cls('in-glass', 'Glass break', 'Intrusion', /glass.?break/,
    SQ + L.G,
    '<rect x="5" y="3" width="14" height="18"/><path d="M12 6l-2 5 3 1-2 6"/>'),
  cls('in-pir', 'Motion detector (PIR)', 'Intrusion', /motion|\bpir\b|occupancy/,
    C + '<path d="M7.5 15.5l4.5-7 4.5 7z"/>',
    '<circle cx="12" cy="7" r="4"/><path d="M5 15c4 3 10 3 14 0M7 19.5c3 2 7 2 10 0"/>'),
  cls('in-siren', 'Siren', 'Intrusion', /siren/,
    C + '<path d="M8 15v-2a4 4 0 0 1 8 0v2zM12 7v1"/>',
    '<path d="M5 18v-5a7 7 0 0 1 14 0v5z"/><path d="M3 21h18M12 3v2M4.5 6l1.5 1.5M19.5 6L18 7.5"/>'),

  // ---- Network
  cls('net-wap', 'Wireless access point', 'Network', /access point|\bwap\b|wi.?fi|wireless access/,
    C + L.W,
    '<circle cx="12" cy="18" r="2" fill="currentColor"/><path d="M8 14.2a5.7 5.7 0 0 1 8 0M4.8 10.6a10.4 10.4 0 0 1 14.4 0M1.8 7.2a14.5 14.5 0 0 1 20.4 0"/>'),
  cls('net-jack', 'Data / telephone jack', 'Network', /data jack|jack|telephone|\btel\b|lv data|data box|lv phone|tv ?(&|and)? ?data/,
    TRI + '<path d="M9 16h6"/>',
    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 9h7v6h-2v1.5h-3V15h-2z"/>'),
  cls('net-switch', 'Switch / rack / MDF', 'Network', /network switch|^switch$|\brack\b|\bmdf\b|\bidf\b|point to point|\bhdmi\b/,
    '<rect x="3" y="6" width="18" height="12" rx="1.5"/>' + dot(7, 12, 1) + dot(10.5, 12, 1) + dot(14, 12, 1) + dot(17.5, 12, 1),
    '<rect x="5" y="2" width="14" height="20" rx="1"/><path d="M5 7h14M5 12h14M5 17h14"/>'),

  // ---- AV / Paging
  cls('av-intercom', 'Intercom / station', 'AV / Paging', /intercom|door station|indoor station|master station|patient station|duty station|pull-cord/,
    C + '<path d="M8 9h8M8 12h8M8 15h5"/>',
    '<rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="7" r="2"/><path d="M9 12h6M9 15h6"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>'),
  cls('av-speaker', 'Speaker', 'AV / Paging', /speaker|\bsip\b|talkback|analog|mic jack/,
    SQ + '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/>',
    '<path d="M3 10v4h4l6 4.5v-13L7 10z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),

  // ---- Power
  cls('pw-outlet', 'Outlet', 'Power', /outlet|receptacle|\bgfi\b/,
    C + '<path d="M9.5 8.5v3M14.5 8.5v3M12 14v1.5"/>',
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
