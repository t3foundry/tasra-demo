import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'

export type UploadedFile = { name: string; bytes: Uint8Array }

const MAX_BYTES = 8 * 1024 * 1024

function sizeLabel(bytes: number): string {
  const kb = bytes / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function FileUpload({
  file,
  onChange,
  accept,
  extensions,
  label = 'Drag & drop your file here',
  hint = 'Up to 8 MB · or click to browse for a file.',
  typeLabel = 'file',
  sampleUrl,
  sampleLabel = 'Use sample file',
  sampleHint = 'Or start with an included sample.',
  disabled = false,
}: {
  file: UploadedFile | null
  onChange: (file: UploadedFile | null) => void
  accept?: string
  extensions?: string[]
  label?: string
  hint?: string
  typeLabel?: string
  sampleUrl?: string
  sampleLabel?: string
  sampleHint?: string
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  const allowed = (extensions ?? []).map((e) => e.toLowerCase())
  const acceptAttr = accept ?? allowed.map((e) => '.' + e).join(',')

  async function read(f: File) {
    if (allowed.length && !allowed.includes(extensionOf(f.name))) {
      setError(
        `Only ${allowed.map((e) => '.' + e).join(', ')} files are accepted.`,
      )
      return
    }
    if (f.size > MAX_BYTES) {
      setError('That file is larger than 8 MB.')
      return
    }
    setError('')
    onChange({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
  }

  async function pick(target: HTMLInputElement) {
    const f = target.files?.[0]
    if (!f) return
    await read(f)
    target.value = ''
  }

  async function useSample() {
    if (!sampleUrl) return
    const res = await fetch(sampleUrl)
    const name = sampleUrl.split('/').pop() || 'sample'
    onChange({ name, bytes: new Uint8Array(await res.arrayBuffer()) })
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void read(f)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      inputRef.current?.click()
    }
  }

  if (file) {
    return (
      <div className={'pdf-chosen' + (disabled ? ' disabled' : '')} role="status">
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
          <small>
            {sizeLabel(file.bytes.length)} · {typeLabel} attached
          </small>
        </div>
        {disabled ? null : (
          <button
            type="button"
            className="pdf-remove"
            aria-label={`Remove ${file.name}`}
            title="Remove"
            onClick={() => onChange(null)}
          >
            ×
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={'drop' + (dragging ? ' dragging' : '')}
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragEnter={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDragging(false)
      }}
      onDrop={onDrop}
    >
      <p>{label}</p>
      <input
        ref={inputRef}
        type="file"
        accept={acceptAttr}
        className="hidden"
        onChange={(e) => void pick(e.currentTarget)}
        onClick={(e) => e.stopPropagation()}
      />
      <p className="hint">{hint}</p>
      {error ? <p className="hint upload-error">{error}</p> : null}
      {sampleUrl ? (
        <>
          <p className="hint">{sampleHint}</p>
          <button
            type="button"
            className="small"
            onClick={(e) => {
              e.stopPropagation()
              void useSample()
            }}
          >
            {sampleLabel}
          </button>
        </>
      ) : null}
    </div>
  )
}