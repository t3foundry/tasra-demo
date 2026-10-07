export type PdfFile = { name: string; bytes: Uint8Array }

function sizeLabel(bytes: number): string {
  const kb = bytes / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`
}

export function PdfUpload({
  file,
  onChange,
  sampleUrl,
  sampleLabel = 'Use sample PDF',
}: {
  file: PdfFile | null
  onChange: (file: PdfFile | null) => void
  sampleUrl?: string
  sampleLabel?: string
}) {
  async function pick(target: HTMLInputElement) {
    const f = target.files?.[0]
    if (!f) return
    onChange({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
    target.value = ''
  }

  async function useSample() {
    if (!sampleUrl) return
    const res = await fetch(sampleUrl)
    onChange({ name: 'sample.pdf', bytes: new Uint8Array(await res.arrayBuffer()) })
  }

  if (file) {
    return (
      <div className="pdf-chosen" role="status">
        <span className="pdf-chosen-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <circle className="pdf-check-bg" cx="12" cy="12" r="11" />
            <path
              d="M7 12.6l3.2 3.1L17 9.2"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="pdf-chosen-info">
          <strong>{file.name}</strong>
          <small>{sizeLabel(file.bytes.length)} · PDF attached</small>
        </div>
        <button
          type="button"
          className="pdf-remove"
          aria-label={`Remove ${file.name}`}
          title="Remove"
          onClick={() => onChange(null)}
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div className="drop">
      <p>Choose your PDF · up to 8 MB</p>
      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => void pick(e.currentTarget)}
      />
      {sampleUrl ? (
        <p className="hint">Or start with the included sample agreement.</p>
      ) : null}
      {sampleUrl ? (
        <button type="button" className="small" onClick={() => void useSample()}>
          {sampleLabel}
        </button>
      ) : null}
    </div>
  )
}