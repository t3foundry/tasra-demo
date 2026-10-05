import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'

GlobalWorkerOptions.workerSrc = '/pdf-assets/pdf.worker.mjs'

export function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(false)

  useEffect(() => {
    let cancelled = false
    getDocument({
      data: Uint8Array.from(bytes),
      cMapUrl: '/pdf-assets/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdf-assets/standard_fonts/',
      wasmUrl: '/pdf-assets/wasm/',
    })
      .promise.then((doc) => {
        if (cancelled) return
        setPdf(doc)
        setTotal(doc.numPages)
        setPage(1)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [bytes])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let active = true
    setRendering(true)
    pdf
      .getPage(page)
      .then(async (p) => {
        const canvas = canvasRef.current
        if (!canvas || !active) return
        const viewport = p.getViewport({ scale: 1.5 })
        canvas.width = viewport.width
        canvas.height = viewport.height
        await p.render({ canvas, viewport }).promise
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
      .finally(() => {
        if (active) setRendering(false)
      })
    return () => {
      active = false
    }
  }, [pdf, page])

  if (error) return <div>Preview unavailable. Use Open PDF to review the original document.</div>

  return (
    <div id="preview" aria-label="Document preview">
      {!pdf ? (
        'Loading PDF…'
      ) : (
        <>
          <div className="pdf-navigation">
            <button
              className="small"
              disabled={rendering || page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span aria-live="polite">
              Page {page} of {total}
            </span>
            <button
              className="small"
              disabled={rendering || page === total}
              onClick={() => setPage((p) => Math.min(total, p + 1))}
            >
              Next
            </button>
          </div>
          <canvas ref={canvasRef} aria-label="PDF page"></canvas>
        </>
      )}
    </div>
  )
}