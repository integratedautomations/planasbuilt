import { AnnotationMode } from 'pdfjs-dist'

// A Revu-marked PDF has its markups baked in as annotations, and pdf.js draws their appearances on the page
// (default annotationMode = ENABLE). After converting them into our own markups they would show twice, so
// the viewer can hide the original annotations per document. The choice is kept on this device.

const key = (documentId: string) => `planmark.origAnnots.${documentId}`

/** Whether the PDF's own annotations are drawn (default yes). */
export function showOriginalAnnots(documentId: string): boolean {
  try { return localStorage.getItem(key(documentId)) !== '0' } catch { return true }
}

export function setShowOriginalAnnots(documentId: string, show: boolean) {
  try { if (show) localStorage.removeItem(key(documentId)); else localStorage.setItem(key(documentId), '0') } catch { /* storage unavailable */ }
}

/** pdf.js render option for the choice. */
export const annotationModeFor = (show: boolean) => (show ? AnnotationMode.ENABLE : AnnotationMode.DISABLE)
