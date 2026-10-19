import { useEffect, useRef } from 'react'
import { PDFDocumentProxy } from '../pdf'

const THUMB_WIDTH = 132

interface Props { pdf: PDFDocumentProxy; current: number; onSelect: (page: number) => void }

export function Thumbnails({ pdf, current, onSelect }: Props) {
  const pages = Array.from({ length: pdf.numPages }, (_, i) => i + 1)
  return (
    <aside className="thumbs">
      {pages.map(n => (
        <button key={n} className={`thumb${n === current ? ' active' : ''}`} onClick={() => onSelect(n)}>
          <Thumb pdf={pdf} pageNum={n} />
          <span>{n}</span>
        </button>
      ))}
    </aside>
  )
}

// Renders lazily the first time the thumbnail scrolls into view.
function Thumb({ pdf, pageNum }: { pdf: PDFDocumentProxy; pageNum: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let task: { cancel: () => void } | null = null
    const io = new IntersectionObserver(async entries => {
      if (!entries[0].isIntersecting) return
      io.disconnect()
      const page = await pdf.getPage(pageNum)
      const base = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: (THUMB_WIDTH * (window.devicePixelRatio || 1)) / base.width })
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      const t = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp })
      task = t
      t.promise.catch(() => {})
    })
    io.observe(canvas)
    return () => { io.disconnect(); task?.cancel() }
  }, [pdf, pageNum])
  return <canvas ref={ref} className="thumb-canvas" />
}
