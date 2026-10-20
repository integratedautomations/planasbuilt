import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Tool } from './types'

export const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
export const icon = (children: ReactNode) => <svg viewBox="0 0 24 24" width="22" height="22" {...s}>{children}</svg>

export const TOOLS: { tool: Tool; label: string; icon: ReactNode }[] = [
  { tool: 'select', label: 'Select', icon: icon(<path d="M5 3l14 8-6 2-3 6z" />) },
  { tool: 'pan', label: 'Pan', icon: icon(<path d="M8 13V5a1.5 1.5 0 013 0v6m0-1V4a1.5 1.5 0 013 0v7m0-5a1.5 1.5 0 013 0v8c0 4-2.5 7-6.5 7S6 18 4.5 15.5L3 13a1.5 1.5 0 012.5-1.5L8 14" />) },
  { tool: 'line', label: 'Line', icon: icon(<path d="M5 19L19 5" />) },
  { tool: 'arrow', label: 'Arrow', icon: icon(<><path d="M5 19L19 5" /><path d="M11 5h8v8" /></>) },
  { tool: 'rect', label: 'Rectangle', icon: icon(<rect x="4" y="6" width="16" height="12" rx="1" />) },
  { tool: 'ellipse', label: 'Ellipse', icon: icon(<ellipse cx="12" cy="12" rx="8" ry="6" />) },
  { tool: 'cloud', label: 'Cloud', icon: icon(<path d="M6 17a3 3 0 01-1-5.8A3.5 3.5 0 0111 8a3.5 3.5 0 016.5 1.5A3.5 3.5 0 0118 17z" />) },
  { tool: 'polyline', label: 'Polyline', icon: icon(<path d="M3 18l5-9 5 6 4-9 4 5" />) },
  { tool: 'polygon', label: 'Polygon', icon: icon(<path d="M12 3l8 6-3 11H7L4 9z" />) },
  { tool: 'freehand', label: 'Pen', icon: icon(<path d="M3 17c3-6 5 2 8-3s4-7 7-6 2 6-2 9" />) },
  { tool: 'text', label: 'Text box', icon: icon(<><path d="M5 6h14M12 6v13" /></>) },
  { tool: 'highlight', label: 'Highlight', icon: icon(<><path d="M9 4l9 9-5 5-9-9z" /><path d="M4 20h7" /></>) },
  { tool: 'device', label: 'Device', icon: icon(<><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" fill="currentColor" /></>) },
  { tool: 'cable', label: 'Cable run', icon: icon(<><path d="M4 18c4 0 4-12 8-12s4 12 8 12" strokeDasharray="3 3" /><circle cx="4" cy="18" r="1.5" fill="currentColor" /><circle cx="20" cy="18" r="1.5" fill="currentColor" /></>) },
  { tool: 'stamp', label: 'Stamp', icon: icon(<><rect x="4" y="14" width="16" height="5" rx="1" /><path d="M9 14v-3a3 3 0 116 0v3" /></>) },
  { tool: 'area', label: 'Area (click points)', icon: icon(<path d="M5 6h6M14 6h5v5M19 14v5h-6M10 19H5v-5M5 11V9" strokeDasharray="3 2.5" />) },
  { tool: 'area-rect', label: 'Area (drag rectangle)', icon: icon(<><rect x="4" y="6" width="16" height="12" rx="1" strokeDasharray="3 2.5" /><path d="M7 9.5h4" /></>) },
  { tool: 'legend', label: 'Legend', icon: icon(<><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M4 9h16M9 9v11M13 13h4M13 16.5h4" /></>) },
  { tool: 'calibrate', label: 'Calibrate scale', icon: icon(<><path d="M3 15l12-12 6 6-12 12z" /><path d="M7 11l2 2M10 8l2 2M13 5l2 2" /></>) },
  { tool: 'measure-length', label: 'Length', icon: icon(<><path d="M4 12h16M4 8v8M20 8v8" /></>) },
  { tool: 'measure-polylength', label: 'Polylength', icon: icon(<><path d="M4 18l5-8 5 5 6-9" /><path d="M3 15v6M21 3v6" /></>) },
  { tool: 'measure-area', label: 'Area', icon: icon(<><path d="M5 7l9-3 5 8-4 7-10-2z" fill="currentColor" fillOpacity="0.2" /></>) },
  { tool: 'count', label: 'Count', icon: icon(<><circle cx="12" cy="12" r="7" fill="currentColor" fillOpacity="0.25" /><path d="M10 10l2-1v6" /></>) },
]

interface Props { hotkeys: Record<string, string>; tool: Tool; onTool: (t: Tool) => void; readOnly: boolean; boxSelect: boolean; onBoxSelect: () => void }

const BOX_ICON = icon(<><rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 2.5" /><path d="M9 12h6M12 9v6" /></>)

// On phones only these stay in the rail; the rest move into the "More" grid (CSS hides .secondary there).
const PRIMARY: Tool[] = ['select', 'pan', 'device', 'cable']
const MORE_ICON = icon(<><circle cx="6" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="18" cy="12" r="1.5" fill="currentColor" /></>)

export function ToolRail({ hotkeys, tool, onTool, readOnly, boxSelect, onBoxSelect }: Props) {
  const [more, setMore] = useState(false)
  const tools = readOnly ? TOOLS.slice(0, 2) : TOOLS
  const secondary = tools.filter(t => !PRIMARY.includes(t.tool))
  const pick = (t: Tool) => { setMore(false); onTool(t) }
  return (
    <nav className="tool-rail" aria-label="Markup tools">
      {tools.map(t => (
        <button key={t.tool} className={`tool-btn${tool === t.tool ? ' active' : ''}${PRIMARY.includes(t.tool) ? '' : ' secondary'}`}
          title={hotkeys[`tool.${t.tool}`] ? `${t.label} (${hotkeys[`tool.${t.tool}`]})` : t.label} aria-pressed={tool === t.tool} onClick={() => pick(t.tool)}>
          {t.icon}
        </button>
      ))}
      <button className={`tool-btn${boxSelect ? ' active' : ''}`} title={`Box select (${hotkeys["select.boxMode"] || "no key"}): drag on empty space to select several`}
        aria-pressed={boxSelect} onClick={() => { setMore(false); onBoxSelect() }}>
        {BOX_ICON}
      </button>
      {secondary.length > 0 && (
        <button className={`tool-btn tool-more${more || secondary.some(t => t.tool === tool) ? ' active' : ''}`}
          title="More tools" aria-expanded={more} onClick={() => setMore(m => !m)}>
          {MORE_ICON}
        </button>
      )}
      {more && (
        <div className="tool-more-grid">
          {secondary.map(t => (
            <button key={t.tool} className={`tool-grid-btn${tool === t.tool ? ' active' : ''}`}
              aria-pressed={tool === t.tool} onClick={() => pick(t.tool)}>
              {t.icon}<span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  )
}
