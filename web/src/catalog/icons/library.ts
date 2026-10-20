// Built-in device icon library: inline SVG, 24x24, one colour (currentColor) so the category colour applies.
// An icon is stored on a device type / symbol set as a data URL (see iconDataUrl), so rendering needs nothing else.

export type IconCategory = 'Video' | 'Fire alarm' | 'Access' | 'Intrusion' | 'Network' | 'AV / Paging' | 'Power' | 'Generic'

export interface IconDef {
  id: string
  name: string
  category: IconCategory
  keywords: string
  /** Inner SVG markup (shapes only). */
  body: string
}

export const ICON_CATEGORIES: IconCategory[] = ['Video', 'Fire alarm', 'Access', 'Intrusion', 'Network', 'AV / Paging', 'Power', 'Generic']

const dots = (pts: [number, number][], r = 1) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`).join('')
const keys = dots([[9, 7], [12, 7], [15, 7], [9, 11], [12, 11], [15, 11], [9, 15], [12, 15], [15, 15], [12, 19]])

const d = (id: string, name: string, category: IconCategory, keywords: string, body: string): IconDef => ({ id, name, category, keywords, body })

export const ICONS: IconDef[] = [
  // ---- Video
  d('cam-dome', 'Dome camera', 'Video', 'cctv camera ip dome', '<path d="M3 17a9 9 0 0 1 18 0z"/><circle cx="12" cy="13" r="2.4" fill="currentColor"/><path d="M2 20.5h20"/>'),
  d('cam-bullet', 'Bullet camera', 'Video', 'cctv camera ip bullet', '<rect x="3" y="8" width="14" height="7" rx="1.5"/><path d="M17 10l4-2v8l-4-2"/><path d="M8 15v4M5 19h6"/>'),
  d('cam-ptz', 'PTZ camera', 'Video', 'cctv camera ptz pan tilt zoom', '<circle cx="12" cy="10" r="5.5"/><circle cx="12" cy="10" r="2" fill="currentColor"/><path d="M8.5 17.5h7M12 15.5v2"/><path d="M2.5 10l2-2M2.5 10l2 2M21.5 10l-2-2M21.5 10l-2 2"/><path d="M9 21h6"/>'),
  d('cam-fisheye', 'Fisheye camera', 'Video', 'cctv camera fisheye 360 panoramic', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/>'),
  d('cam-turret', 'Turret camera', 'Video', 'cctv camera turret eyeball', '<path d="M5 20h14l-2-4H7z"/><circle cx="12" cy="10" r="5"/><circle cx="12" cy="10" r="1.8" fill="currentColor"/>'),
  d('cam-multi', 'Multi-sensor camera', 'Video', 'cctv camera multi sensor panoramic', '<path d="M3 18a9 9 0 0 1 18 0z"/><circle cx="8" cy="14" r="1.6" fill="currentColor"/><circle cx="12" cy="11.5" r="1.6" fill="currentColor"/><circle cx="16" cy="14" r="1.6" fill="currentColor"/>'),
  d('video-nvr', 'NVR', 'Video', 'recorder network video nvr server', '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M6.5 12h6"/><circle cx="17" cy="12" r="1.2" fill="currentColor"/><path d="M7 20h10"/>'),
  d('video-dvr', 'DVR', 'Video', 'recorder digital video dvr', '<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="8" cy="12" r="2" fill="currentColor"/><path d="M13 10h5M13 14h5"/>'),
  d('video-monitor', 'Monitor', 'Video', 'display screen monitor viewing', '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),

  // ---- Fire alarm
  d('fa-smoke', 'Smoke detector', 'Fire alarm', 'fire smoke detector photoelectric', '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-1-1.2-5-1.2-5 .8 0 2.2 5 1.2 5 3.4 0 2-4 2-5.3.6"/>'),
  d('fa-heat', 'Heat detector', 'Fire alarm', 'fire heat detector thermal rate of rise', '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v7"/><circle cx="12" cy="16" r="1.8" fill="currentColor"/>'),
  d('fa-co', 'CO detector', 'Fire alarm', 'carbon monoxide co detector', '<circle cx="12" cy="12" r="9"/><path d="M10.2 9.6a3 3 0 1 0 0 4.8"/><circle cx="15.2" cy="12" r="2.5"/>'),
  d('fa-duct', 'Duct detector', 'Fire alarm', 'fire duct smoke detector hvac', '<path d="M2 13h20M2 19h20"/><rect x="8" y="4" width="8" height="6" rx="1"/><path d="M12 10v9"/>'),
  d('fa-pull', 'Pull station', 'Fire alarm', 'fire manual pull station', '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7.5h6"/><rect x="9" y="12" width="6" height="5" rx="1" fill="currentColor"/>'),
  d('fa-horn-strobe', 'Horn / strobe', 'Fire alarm', 'fire horn strobe notification appliance', '<path d="M3 10v4h4l5 4V6L7 10z"/><path d="M16 8l3-2M17 12h4M16 16l3 2"/>'),
  d('fa-strobe', 'Strobe', 'Fire alarm', 'fire strobe visual notification appliance', '<circle cx="12" cy="12" r="3.5" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2"/>'),
  d('fa-speaker-strobe', 'Speaker / strobe', 'Fire alarm', 'fire speaker strobe voice evacuation notification', '<path d="M2.5 9v6h3l4 3V6l-4 3z"/><circle cx="16.5" cy="12" r="2.2" fill="currentColor"/><path d="M16.5 6v2M16.5 16v2M21.5 12h-1M11.5 12h1M20 7.8l-1.4 1.4M20 16.2l-1.4-1.4"/>'),
  d('fa-monitor-module', 'Monitor module', 'Fire alarm', 'fire addressable monitor module input', '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 15V9l3 4 3-4v6"/><path d="M17 9v6"/>'),
  d('fa-control-module', 'Control module', 'Fire alarm', 'fire addressable control module output', '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M15.5 9.5h-4a1.5 1.5 0 0 0-1.5 1.5v2a1.5 1.5 0 0 0 1.5 1.5h4"/>'),
  d('fa-relay-module', 'Relay module', 'Fire alarm', 'fire relay module contact', '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="13" r="1.1" fill="currentColor"/><path d="M8.5 12.5l7-3.5"/><circle cx="16.5" cy="14.5" r="1.1"/>'),
  d('fa-facp', 'Fire alarm control panel', 'Fire alarm', 'facp fire alarm panel control', '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="12" height="4"/><path d="M7 14h2M11 14h2M15 14h2M7 17.5h2M11 17.5h2M15 17.5h2"/>'),
  d('fa-annunciator', 'Annunciator', 'Fire alarm', 'fire annunciator remote panel', '<rect x="3" y="5" width="18" height="14" rx="2"/>' + dots([[8, 10], [12, 10], [16, 10]], 1.2) + '<path d="M7 15h10"/>'),
  d('fa-beam', 'Beam detector', 'Fire alarm', 'fire beam smoke detector projected', '<rect x="2" y="8" width="5" height="8" rx="1"/><rect x="17" y="8" width="5" height="8" rx="1"/><path d="M9 12h6" stroke-dasharray="2 2"/>'),
  d('fa-flow', 'Sprinkler flow switch', 'Fire alarm', 'sprinkler waterflow flow switch', '<path d="M2 15h20M2 20h20"/><path d="M12 15V8"/><rect x="8.5" y="3.5" width="7" height="4.5" rx="1"/>'),
  d('fa-tamper', 'Sprinkler tamper switch', 'Fire alarm', 'sprinkler tamper valve supervisory', '<path d="M5 8v10l7-5zM19 8v10l-7-5z"/><path d="M12 13V5M9 5h6"/>'),
  d('fa-bell', 'Bell', 'Fire alarm', 'fire bell notification', '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'),

  // ---- Access
  d('ac-reader', 'Card reader', 'Access', 'access control card reader proximity badge', '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 8a3 3 0 0 1 4 0M8.8 5.8a5 5 0 0 1 6.4 0" transform="translate(0 4)"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>'),
  d('ac-keypad', 'Keypad', 'Access', 'access keypad pin code', '<rect x="6" y="2" width="12" height="20" rx="2"/>' + keys),
  d('ac-contact', 'Door contact', 'Access', 'access door position switch contact magnetic', '<rect x="2" y="9" width="8" height="6" rx="1"/><rect x="14" y="9" width="8" height="6" rx="1"/><path d="M11 12h2"/>'),
  d('ac-rex-motion', 'REX motion', 'Access', 'access request to exit motion sensor rex', '<rect x="4" y="3" width="16" height="7" rx="1.5"/><path d="M7 14c3 3 7 3 10 0M9 18c2 2 4 2 6 0"/>'),
  d('ac-rex-button', 'REX button', 'Access', 'access request to exit push button rex', '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  d('ac-maglock', 'Mag lock', 'Access', 'access magnetic lock maglock', '<rect x="2" y="5" width="20" height="6" rx="1"/><rect x="2" y="13" width="20" height="6" rx="1"/><path d="M12 11v2"/>'),
  d('ac-strike', 'Electric strike', 'Access', 'access electric strike lock', '<rect x="7" y="2" width="10" height="20" rx="1"/><rect x="10" y="8" width="7" height="5" fill="currentColor"/>'),
  d('ac-door', 'Door', 'Access', 'door opening', '<rect x="5" y="2" width="14" height="20" rx="1"/><circle cx="15.5" cy="12.5" r="1.1" fill="currentColor"/>'),
  d('ac-gate', 'Gate', 'Access', 'gate barrier fence operator', '<path d="M3 20V5M21 20V5"/><path d="M3 9h18M3 15h18M3 9l18 6M3 15l18-6"/>'),
  d('ac-intercom', 'Intercom / door station', 'Access', 'intercom door station video call', '<rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="7" r="2"/><path d="M9 12h6M9 15h6"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>'),
  d('ac-panel', 'Access panel', 'Access', 'access control panel controller', '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="11" width="8" height="6" rx="1"/><path d="M9.5 11V9a2.5 2.5 0 0 1 5 0v2"/>'),
  d('ac-lock', 'Lock', 'Access', 'lock secure', '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),

  // ---- Intrusion
  d('in-pir', 'Motion sensor (PIR)', 'Intrusion', 'intrusion motion pir passive infrared', '<circle cx="12" cy="7" r="4"/><path d="M5 15c4 3 10 3 14 0M7 19.5c3 2 7 2 10 0"/>'),
  d('in-glass', 'Glass break', 'Intrusion', 'intrusion glass break sensor window', '<rect x="5" y="3" width="14" height="18"/><path d="M12 6l-2 5 3 1-2 6"/>'),
  d('in-panic', 'Panic button', 'Intrusion', 'intrusion panic duress button', '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="16.5" r="1.2" fill="currentColor"/>'),
  d('in-keypad', 'Alarm keypad', 'Intrusion', 'intrusion alarm keypad arm disarm', '<rect x="5" y="2" width="14" height="20" rx="2"/><rect x="8" y="5" width="8" height="3"/>' + dots([[9, 12], [12, 12], [15, 12], [9, 16], [12, 16], [15, 16]])),
  d('in-siren', 'Siren', 'Intrusion', 'intrusion siren sounder alarm', '<path d="M5 18v-5a7 7 0 0 1 14 0v5z"/><path d="M3 21h18M12 3v2M4.5 6l1.5 1.5M19.5 6L18 7.5"/>'),
  d('in-panel', 'Intrusion panel', 'Intrusion', 'intrusion alarm panel control security', '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  d('in-water', 'Water sensor', 'Intrusion', 'water leak flood sensor', '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),

  // ---- Network
  d('net-wap', 'Wireless access point', 'Network', 'wifi wap wireless access point', '<circle cx="12" cy="18" r="2" fill="currentColor"/><path d="M8 14.2a5.7 5.7 0 0 1 8 0M4.8 10.6a10.4 10.4 0 0 1 14.4 0M1.8 7.2a14.5 14.5 0 0 1 20.4 0" transform="translate(0 0)"/>'),
  d('net-switch', 'Switch', 'Network', 'network ethernet switch poe', '<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01" stroke-width="2.6"/>'),
  d('net-router', 'Router', 'Network', 'network router gateway firewall', '<rect x="3" y="12" width="18" height="7" rx="1.5"/><path d="M7 12V8M17 12V8M7 15.5h.01M11 15.5h.01"/><path d="M9 5a4 4 0 0 1 6 0"/>'),
  d('net-jack-1', 'Data jack (single)', 'Network', 'data jack outlet rj45 cat6 single port', '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 9h7v6h-2v1.5h-3V15h-2z"/>'),
  d('net-jack-2', 'Data jack (dual)', 'Network', 'data jack outlet rj45 cat6 dual port', '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8.5 5.5h7v4.5h-2v1h-3v-1h-2zM8.5 13h7v4.5h-2v1h-3v-1h-2z"/>'),
  d('net-jack-4', 'Data jack (quad)', 'Network', 'data jack outlet rj45 cat6 quad four port', '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="5" height="4"/><rect x="13" y="6" width="5" height="4"/><rect x="6" y="14" width="5" height="4"/><rect x="13" y="14" width="5" height="4"/>'),
  d('net-tv-data', 'TV / data jack', 'Network', 'tv coax data jack combo outlet', '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="5.5" y="6" width="5.5" height="4.5"/><circle cx="15.5" cy="14.5" r="3"/><circle cx="15.5" cy="14.5" r="1" fill="currentColor"/>'),
  d('net-rack', 'Rack', 'Network', 'rack idf mdf cabinet', '<rect x="5" y="2" width="14" height="20" rx="1"/><path d="M5 7h14M5 12h14M5 17h14"/>' + dots([[8, 4.5], [8, 9.5], [8, 14.5], [8, 19.5]])),
  d('net-fiber', 'Fiber', 'Network', 'fiber optic cable connector lc sc', '<path d="M3 8h6l2 2v4l-2 2H3"/><path d="M11 12h10"/>'),
  d('net-server', 'Server', 'Network', 'server computer host', '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/>' + dots([[8, 6.5], [8, 17.5]], 1.2) + '<path d="M12 10v4"/>'),

  // ---- AV / Paging
  d('av-ceiling', 'Ceiling speaker', 'AV / Paging', 'audio ceiling speaker paging', '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/>'),
  d('av-wall', 'Wall speaker', 'AV / Paging', 'audio wall speaker', '<rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="15" r="4"/><circle cx="12" cy="6.5" r="1.5"/>'),
  d('av-horn', 'Horn speaker', 'AV / Paging', 'audio horn speaker paging outdoor', '<path d="M3 10v4h3l8 5V5l-8 5z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"/>'),
  d('av-amp', 'Amplifier', 'AV / Paging', 'audio amplifier paging amp', '<rect x="2" y="7" width="20" height="10" rx="1.5"/><circle cx="7" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M16 12h4"/>'),
  d('av-mic', 'Microphone', 'AV / Paging', 'audio microphone paging mic', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>'),
  d('av-display', 'TV / display', 'AV / Paging', 'tv display screen wall mounted', '<rect x="2" y="4" width="20" height="13" rx="1"/><path d="M6 21l2-4M18 21l-2-4"/>'),
  d('av-phone', 'Phone', 'AV / Paging', 'phone telephone voip handset', '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),

  // ---- Power
  d('pw-outlet', 'Outlet', 'Power', 'power outlet receptacle electrical', '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9.5 8v3M14.5 8v3"/><circle cx="12" cy="16" r="1.4"/>'),
  d('pw-supply', 'Power supply', 'Power', 'power supply psu transformer', '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M13 8l-3 4h4l-3 4"/>'),
  d('pw-ups', 'UPS', 'Power', 'ups battery backup', '<rect x="2" y="7" width="18" height="10" rx="1.5"/><path d="M22 10v4M12.5 9.5l-3 2.5h4l-3 2.5"/>'),

  // ---- Generic
  d('g-circle', 'Circle', 'Generic', 'shape circle', '<circle cx="12" cy="12" r="8"/>'),
  d('g-dot', 'Filled circle', 'Generic', 'shape circle dot filled', '<circle cx="12" cy="12" r="8" fill="currentColor"/>'),
  d('g-square', 'Square', 'Generic', 'shape square', '<rect x="4" y="4" width="16" height="16" rx="1.5"/>'),
  d('g-triangle', 'Triangle', 'Generic', 'shape triangle', '<path d="M12 4l9 16H3z"/>'),
  d('g-diamond', 'Diamond', 'Generic', 'shape diamond', '<path d="M12 3l9 9-9 9-9-9z"/>'),
  d('g-star', 'Star', 'Generic', 'shape star', '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  d('g-jbox', 'J-box', 'Generic', 'junction box j-box pull box', '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 4l16 16M20 4L4 20"/>'),
  d('g-conduit', 'Conduit stub', 'Generic', 'conduit stub pipe raceway', '<path d="M5 19V9a4 4 0 0 1 4-4h10"/><path d="M19 2v6"/>'),
]

const BY_ID = new Map(ICONS.map(i => [i.id, i]))
export const iconById = (id: string) => BY_ID.get(id)

/** The full SVG document for an icon, drawn in `color`. */
export function iconSvg(icon: IconDef, color = 'currentColor'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" color="${color}">${icon.body.replace(/currentColor/g, color)}</svg>`
}

/** Data URL to store on a device type / symbol set. White by default: devices draw it on their category-coloured circle. */
export function iconDataUrl(icon: IconDef, color = '#ffffff'): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg(icon, color))}`
}

/** Icons matching a search (name, keywords, category) and an optional category filter. */
export function searchIcons(query: string, category: IconCategory | 'All' = 'All', icons: IconDef[] = ICONS): IconDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return icons.filter(i => (category === 'All' || i.category === category)
    && words.every(w => `${i.name} ${i.keywords} ${i.category} ${i.id}`.toLowerCase().includes(w)))
}
