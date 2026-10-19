import type { ReactNode } from 'react'
import type { Tool } from './types'

const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
const icon = (children: ReactNode) => <svg viewBox="0 0 24 24" width="22" height="22" {...s}>{children}</svg>

export const TOOLS: { tool: Tool; label: string; key: string; icon: ReactNode }[] = [
  { tool: 'select', label: 'Select', key: 'V', icon: icon(<path d="M5 3l14 8-6 2-3 6z" />) },
  { tool: 'pan', label: 'Pan', key: 'H', icon: icon(<path d="M8 13V5a1.5 1.5 0 013 0v6m0-1V4a1.5 1.5 0 013 0v7m0-5a1.5 1.5 0 013 0v8c0 4-2.5 7-6.5 7S6 18 4.5 15.5L3 13a1.5 1.5 0 012.5-1.5L8 14" />) },
  { tool: 'line', label: 'Line', key: 'L', icon: icon(<path d="M5 19L19 5" />) },
  { tool: 'arrow', label: 'Arrow', key: 'A', icon: icon(<><path d="M5 19L19 5" /><path d="M11 5h8v8" /></>) },
  { tool: 'rect', label: 'Rectangle', key: 'R', icon: icon(<rect x="4" y="6" width="16" height="12" rx="1" />) },
  { tool: 'ellipse', label: 'Ellipse', key: 'E', icon: icon(<ellipse cx="12" cy="12" rx="8" ry="6" />) },
  { tool: 'cloud', label: 'Cloud', key: 'C', icon: icon(<path d="M6 17a3 3 0 01-1-5.8A3.5 3.5 0 0111 8a3.5 3.5 0 016.5 1.5A3.5 3.5 0 0118 17z" />) },
  { tool: 'polyline', label: 'Polyline', key: 'P', icon: icon(<path d="M3 18l5-9 5 6 4-9 4 5" />) },
  { tool: 'polygon', label: 'Polygon', key: 'G', icon: icon(<path d="M12 3l8 6-3 11H7L4 9z" />) },
  { tool: 'freehand', label: 'Pen', key: 'F', icon: icon(<path d="M3 17c3-6 5 2 8-3s4-7 7-6 2 6-2 9" />) },
  { tool: 'text', label: 'Text box', key: 'T', icon: icon(<><path d="M5 6h14M12 6v13" /></>) },
  { tool: 'highlight', label: 'Highlight', key: 'I', icon: icon(<><path d="M9 4l9 9-5 5-9-9z" /><path d="M4 20h7" /></>) },
  { tool: 'stamp', label: 'Stamp', key: 'S', icon: icon(<><rect x="4" y="14" width="16" height="5" rx="1" /><path d="M9 14v-3a3 3 0 116 0v3" /></>) },
]

interface Props { tool: Tool; onTool: (t: Tool) => void; readOnly: boolean }

export function ToolRail({ tool, onTool, readOnly }: Props) {
  const tools = readOnly ? TOOLS.slice(0, 2) : TOOLS
  return (
    <nav className="tool-rail" aria-label="Markup tools">
      {tools.map(t => (
        <button key={t.tool} className={`tool-btn${tool === t.tool ? ' active' : ''}`}
          title={`${t.label} (${t.key})`} aria-pressed={tool === t.tool} onClick={() => onTool(t.tool)}>
          {t.icon}
        </button>
      ))}
    </nav>
  )
}
