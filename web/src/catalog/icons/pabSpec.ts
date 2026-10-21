// What the app knows about each device of the built-in icon set (the "pab" set): its readable name, default mount,
// tag prefix, default coverage and the regexp that recognises it by name (used for .btx auto-icons and for matching
// existing device types in the "Standard device library" installer).
//
// The artwork itself is generated from the icon folders into pabIcons.ts (web) and standardLibraryData.ts (server) by
//   node web/scripts/gen-pab-icons.mjs <folder>
// That script imports this file, so keep it free of anything but plain data and functions.

export type PabMount = 'ceiling' | 'wall' | 'square'
export interface PabCoverage { on: boolean; angle: number; range_ft: number }

export interface PabCategory {
  /** Folder name in the icon set, also the first part of every file name. */
  folder: string
  /** Shown in the icon picker and used as the symbol set name by the installer. */
  label: string
  color: string
  /** Symbol set tag prefix. */
  prefix: string
  /** Symbol set shows coverage by default. */
  hasFov: boolean
  /** Device whose option A is the symbol set's own icon. */
  setIcon: string
}

export const PAB_CATEGORIES: PabCategory[] = [
  { folder: 'fire', label: 'Fire Alarm', color: '#e03131', prefix: 'FA', hasFov: false, setIcon: 'fire-smoke' },
  { folder: 'access', label: 'Access Control', color: '#2f9e44', prefix: 'AC', hasFov: false, setIcon: 'access-reader' },
  { folder: 'camera', label: 'Cameras', color: '#1971c2', prefix: 'CAM', hasFov: true, setIcon: 'camera-dome' },
  { folder: 'network', label: 'Network', color: '#7048e8', prefix: 'NET', hasFov: false, setIcon: 'network-wap' },
  { folder: 'intrusion', label: 'Intrusion', color: '#f08c00', prefix: 'IDS', hasFov: false, setIcon: 'intrusion-motion' },
  { folder: 'intercom', label: 'Intercom', color: '#0c8599', prefix: 'IC', hasFov: false, setIcon: 'intercom-door-audio' },
  { folder: 'nursecall', label: 'Nurse Call', color: '#d6336c', prefix: 'NC', hasFov: false, setIcon: 'nursecall-patient' },
  { folder: 'paging', label: 'Paging / Audio', color: '#e8590c', prefix: 'PA', hasFov: false, setIcon: 'paging-speaker-ceiling' },
  { folder: 'automation', label: 'Automation', color: '#5c940d', prefix: 'HA', hasFov: false, setIcon: 'automation-thermostat' },
  { folder: 'general', label: 'General', color: '#868e96', prefix: 'GEN', hasFov: false, setIcon: 'general-jbox' },
]

export const PAB_CATEGORY_LABELS: string[] = PAB_CATEGORIES.map(c => c.label)
export const pabCategoryByFolder = (folder: string) => PAB_CATEGORIES.find(c => c.folder === folder)

const ACRONYMS: Record<string, string> = {
  rex: 'REX', co: 'CO', nac: 'NAC', ptz: 'PTZ', nvr: 'NVR', lpr: 'LPR', facp: 'FACP', dact: 'DACT', fdc: 'FDC', ror: 'ROR', rta: 'RTA',
  pth: 'PTH', tv: 'TV', wap: 'WAP', poe: 'PoE', ip: 'IP', pir: 'PIR', ups: 'UPS', dvr: 'DVR', mdf: 'MDF', idf: 'IDF', av: 'AV',
  jbox: 'J-Box', x2: 'x2', x4: 'x4',
}

/**
 * Readable name from a file slug: "access-rex-motion" -> "REX Motion". The category word is dropped and acronyms are
 * upper-cased. Devices whose generic reading is poor have an explicit name in DEVICES.
 */
export function slugToName(slug: string): string {
  const parts = slug.split('-')
  if (parts.length > 1) parts.shift()
  return parts.map(p => ACRONYMS[p] ?? p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
}

export interface PabDeviceSpec {
  slug: string
  /** Explicit name; otherwise slugToName(slug). */
  name?: string
  mount: PabMount
  /** Default tag prefix (letters and digits, unique within the category). */
  prefix: string
  /** Matches a lower-cased, whitespace-normalised device name. Earlier devices win. */
  match: RegExp
  coverage?: PabCoverage
}

const cov = (angle: number, range_ft: number): PabCoverage => ({ on: true, angle, range_ft })
const d = (slug: string, mount: PabMount, prefix: string, match: RegExp, extra: { name?: string; coverage?: PabCoverage } = {}): PabDeviceSpec =>
  ({ slug, mount, prefix, match, ...extra })

/**
 * Every device, in matching priority: a name is recognised as the first device whose regexp matches, so specific
 * devices come before the generic ones they could be confused with ("duct detector" before "detector", "paging horn"
 * before "horn", "alarm keypad" before "keypad").
 */
export const DEVICES: PabDeviceSpec[] = [
  // ---- Specific names that other groups would otherwise swallow
  d('nursecall-bath', 'wall', 'BTH', /\bbath\b|toilet|shower/, { name: 'Bath Station' }),
  d('nursecall-dome-light', 'ceiling', 'DL', /dome light|corridor light|dome lamp/),
  d('paging-horn', 'wall', 'PH', /paging horn|re.?entrant|projector/, { name: 'Paging Horn', coverage: cov(90, 60) }),
  d('intrusion-siren-ext', 'wall', 'ESR', /exterior siren|outdoor siren|bell box/, { name: 'Exterior Siren' }),
  d('intrusion-overhead-contact', 'wall', 'OHC', /overhead|garage door contact/, { name: 'Overhead Door Contact' }),
  d('intrusion-window-contact', 'wall', 'WC', /window (contact|sensor)/, { name: 'Window Contact' }),
  d('intrusion-door-contact', 'wall', 'ADC', /alarm door contact|burglar door|door sensor/, { name: 'Alarm Door Contact' }),
  d('intercom-door-release', 'wall', 'DR', /door release/, { name: 'Door Release' }),
  d('access-power-supply', 'square', 'APS', /access power|lock power|door power/, { name: 'Access Power Supply' }),
  d('network-tv', 'wall', 'TVC', /coax|catv|tv outlet|tv ?\/ ?coax/, { name: 'TV / Coax Outlet' }),
  d('access-rex-button', 'wall', 'RXB', /exit button|rex button|push to exit|request to exit button/, { name: 'REX Button' }),
  d('access-rex-motion', 'ceiling', 'REX', /request to exit|\brex\b|touchless/, { name: 'REX Motion' }),

  // ---- Fire alarm
  d('fire-smoke-duct-rta', 'wall', 'RTS', /remote test|\brts\b|\brta\b/, { name: 'Remote Test Station' }),
  d('fire-heat-ror', 'ceiling', 'HR', /rate.of.rise|\bror\b/, { name: 'Rate-of-Rise Heat Detector' }),
  d('fire-heat-linear', 'ceiling', 'LHD', /linear heat|heat cable/, { name: 'Linear Heat Detection' }),
  d('fire-co', 'ceiling', 'CO', /carbon mon|\bco\b|smoke.?\/?co/, { name: 'CO Detector' }),
  d('fire-duct', 'square', 'DD', /\bduct\b/, { name: 'Duct Detector' }),
  d('fire-beam', 'wall', 'BM', /beam/, { name: 'Beam Detector' }),
  d('fire-flame', 'wall', 'FLM', /flame|uv.?ir/, { name: 'Flame Detector' }),
  d('fire-speaker-strobe', 'wall', 'SS', /speaker.?(\/|-)?\s?strobe/, { name: 'Speaker/Strobe' }),
  d('fire-speaker', 'ceiling', 'FSP', /fire speaker|evac|emergency speaker/, { name: 'Fire Speaker' }),
  d('fire-horn-strobe', 'wall', 'HS', /horn.?(\/|-)?\s?strobe|sounder.?(\/|-)?\s?strobe/, { name: 'Horn/Strobe' }),
  d('fire-strobe', 'wall', 'ST', /strobe/, { name: 'Strobe' }),
  d('fire-horn', 'wall', 'HN', /horn|sounder/, { name: 'Horn' }),
  d('fire-smoke', 'ceiling', 'SD', /smoke|fire address|detector with sounder|photoelectric|ionization/, { name: 'Smoke Detector' }),
  d('fire-heat', 'ceiling', 'HD', /heat|thermal/, { name: 'Heat Detector' }),
  d('fire-pull', 'wall', 'PS', /pull station|manual station|manual pull|fire service or emergency/, { name: 'Pull Station' }),
  d('fire-control-module', 'square', 'CM', /control module|output module/, { name: 'Control Module' }),
  d('fire-relay', 'square', 'RLY', /relay|web relay/, { name: 'Relay Module' }),
  d('fire-isolator', 'square', 'ISO', /isolator/, { name: 'Isolator Module' }),
  d('fire-monitor-module', 'square', 'MM', /monitor module|input module|\bmodule\b/, { name: 'Monitor Module' }),
  d('fire-waterflow', 'square', 'WF', /water ?flow|flow switch/, { name: 'Waterflow Switch' }),
  d('fire-tamper', 'square', 'TS', /tamper|supervisory/, { name: 'Tamper Switch' }),
  d('fire-facp', 'square', 'FACP', /fire alarm (control )?panel|facp/, { name: 'Fire Alarm Control Panel' }),
  d('fire-dact', 'square', 'DACT', /dact|dialer|alarm communicator/, { name: 'DACT / Communicator' }),
  d('fire-nac-extender', 'square', 'NAC', /\bnac\b|booster|power supply/, { name: 'NAC Extender' }),
  d('fire-door-holder', 'wall', 'DH', /door holder|magnetic release|door hold/, { name: 'Door Holder' }),
  d('fire-knox-box', 'wall', 'KNX', /knox|key ?box|lockbox/, { name: 'Knox Box' }),
  d('fire-fdc', 'wall', 'FDC', /\bfdc\b|fire department connection|siamese/, { name: 'Fire Department Connection' }),
  d('nursecall-annunciator', 'wall', 'NCA', /nurse (call )?annunciator/, { name: 'Nurse Call Annunciator' }),
  d('fire-annunciator', 'wall', 'ANN', /annunciator/, { name: 'Annunciator' }),

  // ---- Cameras
  d('camera-ptz', 'ceiling', 'PTZ', /\bptz\b|pan.?tilt/, { name: 'PTZ Camera', coverage: cov(360, 100) }),
  d('camera-fisheye', 'ceiling', 'FE', /fish.?eye|360 camera|180 degree|panoramic/, { name: 'Fisheye Camera', coverage: cov(360, 40) }),
  d('camera-multi-sensor', 'ceiling', 'MSC', /multi.?sensor|multi.?imager/, { name: 'Multi-Sensor Camera', coverage: cov(180, 60) }),
  d('camera-lpr', 'wall', 'LPR', /\blpr\b|license plate/, { name: 'LPR Camera', coverage: cov(40, 80) }),
  d('camera-doorbell', 'wall', 'VDB', /doorbell/, { name: 'Video Doorbell', coverage: cov(100, 20) }),
  d('camera-turret', 'ceiling', 'TUR', /turret|eyeball/, { name: 'Turret Camera', coverage: cov(100, 50) }),
  d('camera-dome', 'ceiling', 'DOM', /dome|indoor camera|ceiling camera|megapixel/, { name: 'Dome Camera', coverage: cov(100, 50) }),
  d('camera-nvr', 'square', 'NVR', /\bnvr\b|\bdvr\b|video recorder|recorder|\bvms\b/, { name: 'NVR / Recorder' }),
  d('camera-monitor', 'wall', 'MON', /monitor|display|screen|viewing station/, { name: 'Monitor' }),
  d('camera-bullet', 'wall', 'BUL', /bullet|camera|cctv/, { name: 'Bullet Camera', coverage: cov(90, 80) }),

  // ---- Network
  d('network-poe-injector', 'square', 'POE', /injector|power over ethernet/, { name: 'PoE Injector' }),
  d('network-patch-panel', 'square', 'PPNL', /patch panel/, { name: 'Patch Panel' }),
  d('network-firewall', 'square', 'FW', /firewall|router|gateway/, { name: 'Router / Firewall' }),
  d('network-demarc', 'square', 'DMC', /demarc|\bmpoe\b|isp entrance/, { name: 'Demarc' }),
  d('network-fiber', 'square', 'FIB', /fib(er|re)/, { name: 'Fiber Termination' }),
  d('network-floor-box', 'square', 'FB', /floor box|poke.?through|floor data/, { name: 'Floor Box' }),
  d('network-ceiling-drop', 'ceiling', 'CD', /ceiling drop|ceiling data/, { name: 'Ceiling Drop' }),
  d('network-rack', 'square', 'RACK', /\brack\b|\bmdf\b|\bidf\b|cabinet/, { name: 'Rack / MDF' }),
  d('network-switch', 'square', 'SW', /network switch|^switch$|poe switch|point to point|\bhdmi\b/, { name: 'Network Switch' }),
  d('network-wap', 'ceiling', 'WAP', /access point|\bwap\b|wi.?fi|wireless access/, { name: 'Wireless Access Point' }),
  d('network-data-x4', 'wall', 'DJ4', /(data|jack|outlet).*(x ?4\b|quad|4.?port|four)/, { name: 'Data Outlet x4' }),
  d('network-data-x2', 'wall', 'DJ2', /(data|jack|outlet).*(x ?2\b|dual|2.?port|two)/, { name: 'Data Outlet x2' }),
  d('network-data', 'wall', 'DJ', /data jack|data outlet|\bjack\b|rj45|lv data|data box|tv ?(&|and)? ?data/, { name: 'Data Outlet' }),
  d('paging-phone-interface', 'square', 'TPI', /paging interface|phone paging|telephone paging/, { name: 'Telephone Paging Interface' }),
  d('network-voice', 'wall', 'VO', /voice|telephone|\btel\b|lv phone|phone outlet/, { name: 'Voice Outlet' }),

  // ---- Intrusion
  d('intrusion-ceiling-motion', 'ceiling', 'CPIR', /ceiling motion|360 motion/, { name: 'Ceiling Motion', coverage: cov(360, 20) }),
  d('intrusion-dual-tech', 'ceiling', 'DT', /dual.?tech|microwave/, { name: 'Dual-Tech Motion', coverage: cov(90, 40) }),
  d('intrusion-motion', 'ceiling', 'PIR', /motion|\bpir\b/, { name: 'Motion Detector', coverage: cov(90, 35) }),
  d('intrusion-glass-break', 'ceiling', 'GB', /glass.?break/, { name: 'Glass Break', coverage: cov(360, 25) }),
  d('intrusion-shock', 'wall', 'SHK', /shock|vibration/, { name: 'Shock Sensor' }),
  d('intrusion-panic', 'wall', 'PNC', /panic|duress|hold.?up/, { name: 'Panic Button' }),
  d('intrusion-water', 'ceiling', 'FLD', /flood|water sensor|water detection/, { name: 'Flood Sensor' }),
  d('intrusion-temp', 'ceiling', 'TMP', /temperature sensor|temp sensor|freeze/, { name: 'Temperature Sensor' }),
  d('intrusion-panel', 'square', 'IDP', /alarm panel|intrusion panel|burglar/, { name: 'Alarm Panel' }),
  d('intrusion-keypad', 'wall', 'AK', /alarm keypad|arming station|arm.?disarm/, { name: 'Alarm Keypad' }),
  d('intrusion-siren', 'wall', 'SRN', /siren/, { name: 'Siren' }),
  d('intrusion-communicator', 'square', 'COM', /communicator|cellular/, { name: 'Cellular Communicator' }),
  d('intrusion-receiver', 'square', 'RCV', /wireless receiver|transceiver|receiver/, { name: 'Wireless Receiver' }),

  // ---- Intercom
  d('intercom-door-video', 'wall', 'VDS', /video door|video intercom/, { name: 'Video Door Station' }),
  d('intercom-door-audio', 'wall', 'DSA', /door station|audio door/, { name: 'Audio Door Station' }),
  d('intercom-entry-panel', 'wall', 'EP', /entry panel|directory/, { name: 'Entry Panel' }),
  d('intercom-callbox', 'wall', 'CB', /call ?box|pedestal/, { name: 'Call Box' }),
  d('intercom-handset', 'wall', 'IH', /handset/, { name: 'Intercom Handset' }),
  d('intercom-controller', 'square', 'ICC', /intercom controller|intercom server/, { name: 'Intercom Controller' }),
  d('intercom-desk', 'square', 'DS', /desk station|console/, { name: 'Desk Station' }),
  d('intercom-substation', 'wall', 'SUB', /sub.?station|indoor station|room station/, { name: 'Substation' }),

  // ---- Nurse call
  d('nursecall-code-blue', 'wall', 'CBL', /code blue/, { name: 'Code Blue' }),
  d('nursecall-master', 'square', 'NMS', /nurse master|nurse console/, { name: 'Nurse Master Station' }),
  d('nursecall-controller', 'square', 'NCC', /nurse (call )?controller/, { name: 'Nurse Call Controller' }),
  d('nursecall-locator', 'ceiling', 'LOC', /locator|badge receiver/, { name: 'Staff Locator' }),
  d('nursecall-patient', 'wall', 'PTS', /patient station|nurse call station|bed station/, { name: 'Patient Station' }),
  d('nursecall-pillow', 'wall', 'PIL', /pillow/, { name: 'Pillow Speaker' }),
  d('nursecall-cord', 'wall', 'CC', /call cord|bed cord|pull.?cord/, { name: 'Call Cord' }),
  d('nursecall-staff', 'wall', 'STF', /staff station|duty station/, { name: 'Staff Station' }),
  d('paging-pendant', 'ceiling', 'PND', /pendant speaker|hanging speaker/, { name: 'Pendant Speaker', coverage: cov(360, 20) }),
  d('nursecall-pendant', 'wall', 'WPN', /pendant|transmitter/, { name: 'Wireless Pendant' }),
  d('intercom-master', 'square', 'MST', /master station|\bintercom\b/, { name: 'Master Station' }),

  // ---- Paging / audio
  d('automation-speaker-ceiling', 'ceiling', 'AVC', /av (ceiling|in.?ceiling) speaker|in.?ceiling speaker/, { name: 'AV Ceiling Speaker', coverage: cov(360, 15) }),
  d('automation-speaker-wall', 'wall', 'AVW', /av (wall|in.?wall) speaker|in.?wall speaker/, { name: 'AV Wall Speaker', coverage: cov(120, 20) }),
  d('paging-speaker-wall', 'wall', 'WS', /wall speaker/, { name: 'Wall Speaker', coverage: cov(120, 20) }),
  d('paging-speaker-ceiling', 'ceiling', 'CS', /speaker|\bsip\b|talkback|analog|mic jack/, { name: 'Ceiling Speaker', coverage: cov(360, 15) }),
  d('paging-amplifier', 'square', 'AMP', /amplifier|\bamp\b/, { name: 'Amplifier' }),
  d('paging-zone', 'square', 'PZC', /zone controller|paging zone/, { name: 'Paging Zone Controller' }),
  d('paging-mic', 'wall', 'MIC', /microphone|\bmic\b/, { name: 'Paging Microphone' }),
  d('paging-volume', 'wall', 'VC', /volume|attenuator/, { name: 'Volume Control' }),
  d('paging-clock', 'wall', 'CLK', /clock/, { name: 'Clock' }),
  d('paging-bell', 'wall', 'BELL', /\bbell\b|tone signal/, { name: 'Bell' }),

  // ---- Automation
  d('automation-processor', 'square', 'AP', /processor|automation hub|crestron/, { name: 'Automation Processor' }),
  d('automation-keypad', 'wall', 'LK', /lighting keypad|scene keypad|scene button/, { name: 'Lighting Keypad' }),
  d('automation-touchscreen', 'wall', 'TP', /touch ?panel|touch ?screen/, { name: 'Touch Panel' }),
  d('automation-dimmer', 'wall', 'DIM', /dimmer/, { name: 'Dimmer' }),
  d('automation-switch', 'wall', 'LS', /light switch|lighting switch|wall switch/, { name: 'Light Switch' }),
  d('automation-fan', 'wall', 'FC', /\bfan\b/, { name: 'Fan Control' }),
  d('automation-shade', 'wall', 'SHD', /shade|blind|motorized/, { name: 'Shade Motor' }),
  d('automation-thermostat', 'wall', 'TSTAT', /thermostat|hvac control|climate/, { name: 'Thermostat' }),
  d('automation-occupancy', 'ceiling', 'OCC', /occupancy|vacancy/, { name: 'Occupancy Sensor', coverage: cov(360, 20) }),
  d('automation-lock', 'wall', 'SL', /smart lock|deadbolt/, { name: 'Smart Lock' }),
  d('automation-garage', 'wall', 'GDC', /garage door/, { name: 'Garage Door Controller' }),
  d('automation-leak', 'ceiling', 'LEAK', /leak/, { name: 'Leak Sensor' }),
  d('automation-valve', 'square', 'WSV', /shut.?off|valve/, { name: 'Water Shutoff Valve' }),
  d('automation-outlet', 'wall', 'PLG', /smart (plug|outlet)|plug module/, { name: 'Smart Plug' }),
  d('automation-tv', 'wall', 'TV', /\btv\b|television/, { name: 'TV Location' }),
  d('automation-repeater', 'ceiling', 'RPT', /repeater|zigbee|z.?wave|mesh/, { name: 'Mesh Repeater' }),

  // ---- Access control
  d('access-maglock', 'wall', 'ML', /mag.?lock|magnetic lock/, { name: 'Mag Lock' }),
  d('access-strike', 'wall', 'ES', /strike|door lock|lock repeater/, { name: 'Electric Strike' }),
  d('access-lever', 'wall', 'EL', /lever|mortise|electrified/, { name: 'Electrified Lever' }),
  d('access-pth', 'wall', 'PTH', /power transfer|\bpth\b|\bept\b|hinge/, { name: 'Power Transfer Hinge' }),
  d('access-door-contact', 'wall', 'DC', /door contact|door position|\bdps\b|contact/, { name: 'Door Contact' }),
  d('access-biometric', 'wall', 'BIO', /biometric|fingerprint|iris|face reader/, { name: 'Biometric Reader' }),
  d('access-combo', 'wall', 'RK', /reader.?(\/|-)?\s?keypad|keypad.?(\/|-)?\s?reader|combo/, { name: 'Reader/Keypad' }),
  d('access-keypad', 'wall', 'KP', /keypad/, { name: 'Keypad' }),
  d('access-reader', 'wall', 'CR', /card ?reader|cardereader|reader|badge|prewire for access|^access control$/, { name: 'Card Reader' }),
  d('access-auto-operator', 'wall', 'ADO', /door operator|auto.?operator|auto door|ada operator/, { name: 'Auto Door Operator' }),
  d('access-push-plate', 'wall', 'PP', /push plate|ada actuator|actuator|wave to open/, { name: 'Push Plate' }),
  d('access-turnstile', 'square', 'TURN', /turnstile|optical barrier|speed gate/, { name: 'Turnstile' }),
  d('access-gate', 'square', 'GO', /gate operator|vehicle gate|\bgate\b/, { name: 'Gate Operator' }),
  d('access-emergency-release', 'wall', 'ER', /emergency release|break glass|emergency door/, { name: 'Emergency Release' }),
  d('access-controller', 'square', 'DCT', /access control panel|door controller|access panel|controller/, { name: 'Door Controller' }),

  // ---- General
  d('general-jbox', 'square', 'JB', /j.?box|junction box/, { name: 'J-Box' }),
  d('general-backbox', 'square', 'BB', /back ?box|single gang/, { name: 'Back Box' }),
  d('general-pull-box', 'square', 'PB', /pull box/, { name: 'Pull Box' }),
  d('general-conduit-stub', 'square', 'CST', /conduit/, { name: 'Conduit Stub' }),
  d('general-power', 'wall', 'PWR', /120v|power outlet|outlet|receptacle|\bgfi\b/, { name: '120V Power Outlet' }),
  d('general-head-end', 'square', 'HE', /head.?end|equipment room/, { name: 'Head End' }),
]

const BY_SLUG = new Map(DEVICES.map(x => [x.slug, x]))
export const deviceSpec = (slug: string) => BY_SLUG.get(slug)
export const deviceName = (slug: string) => BY_SLUG.get(slug)?.name ?? slugToName(slug)

/** Category folder of a slug ("fire-smoke" -> "fire"). */
export const folderOf = (slug: string) => slug.split('-')[0]

/** Normalises a device name the way the matchers expect. */
export const normName = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim()

/** The first device (optionally limited to one category folder) whose matcher recognises `name`. */
export function matchDevice(name: string, folder?: string): PabDeviceSpec | undefined {
  const n = normName(name)
  if (!n) return undefined
  return DEVICES.find(x => (!folder || folderOf(x.slug) === folder) && x.match.test(n))
}
