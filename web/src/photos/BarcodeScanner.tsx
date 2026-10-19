import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import './photos.css'

interface Props { onResult: (text: string) => void; onClose: () => void }

type NativeDetector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
type NativeCtor = { new (o: { formats: string[] }): NativeDetector }

function describe(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    return 'The camera needs a secure connection (HTTPS or localhost). Open PlanAsBuilt over HTTPS to scan.'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. Allow camera access in your browser settings and try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is in use by another app.'
  return `Could not start the camera: ${(e as Error)?.message ?? 'unknown error'}`
}

export function BarcodeScanner({ onResult, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const cb = useRef({ onResult, onClose })
  cb.current = { onResult, onClose }

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let controls: { stop(): void } | null = null
    let raf = 0
    const v0 = video.current
    const stop = () => {
      stopped = true
      cancelAnimationFrame(raf)
      try { controls?.stop() } catch { /* ignore */ }
      stream?.getTracks().forEach(t => t.stop())
      const s = v0?.srcObject as MediaStream | null
      s?.getTracks().forEach(t => t.stop())
      if (v0) v0.srcObject = null
    }
    const found = (text: string) => {
      if (stopped) return
      stop()
      cb.current.onResult(text)
    }
    ;(async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('insecure')
        const constraints: MediaStreamConstraints = { video: { facingMode: { ideal: 'environment' } }, audio: false }
        const Native = (window as unknown as { BarcodeDetector?: NativeCtor }).BarcodeDetector
        if (Native) {
          stream = await navigator.mediaDevices.getUserMedia(constraints)
          if (stopped) { stream.getTracks().forEach(t => t.stop()); return }
          const v = video.current!
          v.srcObject = stream
          await v.play().catch(() => {})
          const det = new Native({ formats: ['qr_code', 'code_128', 'code_39', 'data_matrix'] })
          let last = 0
          const tick = async (t: number) => {
            if (stopped) return
            if (t - last > 150 && v.readyState >= 2) {
              last = t
              try {
                const r = await det.detect(v)
                if (r[0]?.rawValue) return found(r[0].rawValue)
              } catch { /* keep trying */ }
            }
            raf = requestAnimationFrame(tick)
          }
          raf = requestAnimationFrame(tick)
        } else {
          const hints = new Map<DecodeHintType, unknown>()
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.DATA_MATRIX])
          hints.set(DecodeHintType.TRY_HARDER, true)
          const reader = new BrowserMultiFormatReader(hints)
          const c = await reader.decodeFromConstraints(constraints, video.current!, (result) => {
            if (result) found(result.getText())
          })
          if (stopped) c.stop(); else controls = c
        }
      } catch (e) {
        if (!stopped) setError(describe(e))
      }
    })()
    return stop
  }, [])

  return (
    <div className="photo-modal" role="dialog" aria-label="Scan barcode">
      <div className="pm-bar">
        <strong className="grow">Scan barcode or QR code</strong>
        <button onClick={onClose}>Cancel</button>
      </div>
      {error ? <div className="pm-msg">{error}</div> : <video ref={video} className="pm-video" playsInline muted />}
    </div>
  )
}
