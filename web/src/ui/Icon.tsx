import type { ReactNode, SVGProps } from 'react'

// Small inline outline icon set: 24 viewBox, stroke = currentColor, 1.75 width. No icon package needed.
const P: Record<string, ReactNode> = {
  'arrow-left': <><path d="M5 12h14" /><path d="M5 12l6 6" /><path d="M5 12l6-6" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  dots: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 000 11H13" /></>,
  'sidebar-left': <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16" /></>,
  'sidebar-right': <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M15 4v16" /></>,
  layers: <><path d="M12 4l8 4-8 4-8-4z" /><path d="M4 12l8 4 8-4" /><path d="M4 16l8 4 8-4" /></>,
  list: <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M5 6h.01" /><path d="M5 12h.01" /><path d="M5 18h.01" /></>,
  map: <><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z" /><path d="M9 4v13" /><path d="M15 7v13" /></>,
  compare: <><rect x="3" y="5" width="8" height="14" rx="1" /><rect x="13" y="5" width="8" height="14" rx="1" /><path d="M12 3v18" /></>,
  print: <><path d="M7 9V4h10v5" /><rect x="4" y="9" width="16" height="8" rx="2" /><path d="M7 14h10v6H7z" /></>,
  'file-pdf': <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /><path d="M9 17v-4h1.5a1.2 1.2 0 010 2.4H9" /></>,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01" /><path d="M11 10h.01" /><path d="M15 10h.01" /><path d="M7 14h10" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-left': <path d="M15 6l-6 6 6 6" />,
  'sidebar-bottom': <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 15h16" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  minus: <path d="M5 12h14" />,
  x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></>,
  trash: <><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12" /><path d="M9 7V4h6v3" /></>,
  replace: <><path d="M4 10h13" /><path d="M13 6l4 4-4 4" /><path d="M20 14H7" /><path d="M11 18l-4-4 4-4" transform="translate(0 0)" /></>,
  pin: <><path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" /></>,
  star: <path d="M12 4l2.4 5 5.6.7-4.1 3.8 1.1 5.5L12 16.3 7 19l1.1-5.5L4 9.7 9.6 9z" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  'eye-off': <><path d="M10 6a9 9 0 012-.5C18 5.5 21.5 12 21.5 12a16 16 0 01-2.6 3.4" /><path d="M6.6 7.4A16 16 0 002.5 12S6 18.5 12 18.5a9 9 0 004.2-1" /><path d="M3 3l18 18" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  maximize: <><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>,
  bell: <><path d="M6 17V11a6 6 0 0112 0v6l1.5 2h-15z" /><path d="M10 21h4" /></>,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" /></>,
  palette: <><path d="M12 4a8 8 0 100 16c1.2 0 1.8-.8 1.8-1.7 0-1.5-1.3-1.6-1.3-3 0-1 .8-1.8 1.9-1.8H17a3.5 3.5 0 003.5-3.5C20.5 6.7 16.8 4 12 4z" /><circle cx="8" cy="11" r=".6" /><circle cx="11" cy="7.5" r=".6" /><circle cx="15" cy="8" r=".6" /></>,
  tools: <><path d="M4 8h16v11H4z" /><path d="M9 8V5h6v3" /><path d="M4 13h16" /></>,
  pages: <><rect x="6" y="3" width="12" height="18" rx="1.5" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  'device-size': <><circle cx="8.5" cy="15.5" r="3.5" /><circle cx="15" cy="9" r="6" /></>,
  more: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
}

export type IconName = keyof typeof P

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden focusable="false" {...rest}>{P[name]}</svg>
  )
}
