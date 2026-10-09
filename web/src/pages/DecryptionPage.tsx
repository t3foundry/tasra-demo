import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { api } from '../api'
import { useNotice } from '../notice'
import { shortSlot } from '../components'
import { PdfPreview } from '../PdfPreview'
import type { EncryptionBundle } from '../../../shared/encrypt'

type OpenResult = { id: string; qrPayload: string; qrDataUrl: string }

type StatusResult =
  | { status: 'awaiting' | 'processing'; qrPayload?: string; qrDataUrl?: string }
  | { status: 'done'; plaintextBase64: string; pdfSize: number; fileName: string }
  | { status: 'failed'; error?: string }

const explorer = (slotId: string) =>
  `https://explorer.t3-foundry.fuji.tasra.network/slots/${slotId}`

const shortIdentity = (identity: string) =>
  identity.length <= 10 ? identity : identity.slice(0, 40) + '…' + identity.slice(-40)

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function downloadPdf(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(
    new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export function DecryptionPage() {
  const notice = useNotice()
  const [bundle, setBundle] = useState<EncryptionBundle | null>(null)
  const [busy, setBusy] = useState(false)
  const [remote, setRemote] = useState<{ qrPayload: string; qrDataUrl: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [plaintext, setPlaintext] = useState<Uint8Array | null>(null)
  const [pdfName, setPdfName] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    void onFile(e.dataTransfer.files?.[0])
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fileRef.current?.click()
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    setBundle(null)
    setPlaintext(null)
    setRemote(null)
    try {
      const parsed = JSON.parse(await file.text()) as Partial<EncryptionBundle>
      const m = parsed.manifest
      const ct = parsed.ciphertext
      if (
        !m ||
        !ct ||
        m.schema !== 'tasra-encrypt/v1' ||
        typeof m.title !== 'string' ||
        typeof m.identity !== 'string' ||
        !/^0x[0-9a-f]{64}$/i.test(m.slotId ?? '') ||
        typeof ct.u !== 'string' ||
        typeof ct.nonce !== 'string' ||
        typeof ct.aeadCt !== 'string'
      )
        throw new Error('That file is not a Tasra encryption bundle')
      setBundle(parsed as EncryptionBundle)
      notice('Ciphertext loaded. Ready to request decryption.', 'success')
    } catch (e) {
      notice('Could not read that file: ' + (e as Error).message, 'error')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function startDecrypt() {
    if (!bundle) return
    setBusy(true)
    setRemote(null)
    setPlaintext(null)
    notice('Opening a wallet session for decryption…')
    try {
      const opened = await api<OpenResult>('/encryption/decrypt', { bundle })
      setRemote({ qrPayload: opened.qrPayload, qrDataUrl: opened.qrDataUrl })
      notice('Scan the QR with the holder’s remote wallet to authorize decryption')
      const deadline = Date.now() + 5 * 60 * 1000
      while (true) {
        const s = await api<StatusResult>(`/encryption/decrypt/${opened.id}/status`, {})
        if (s.status === 'done') {
          const bytes = fromBase64(s.plaintextBase64)
          setPlaintext(bytes)
          setPdfName(s.fileName)
          setRemote(null)
          notice('Document decrypted', 'success')
          return
        }
        if (s.status === 'failed') throw new Error(s.error ?? 'Decryption failed')
        if (Date.now() > deadline) throw new Error('Wallet session timed out')
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } catch (e) {
      setRemote(null)
      notice((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function copyRemote() {
    if (!remote) return
    try {
      await navigator.clipboard.writeText(remote.qrPayload)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      notice('Could not copy: ' + (e as Error).message, 'error')
    }
  }

  const m = bundle?.manifest

  return (
    <>
      <div className="topline">
        <div>
          <div className="eyebrow">Decryption</div>
          <h1>Open a private document.</h1>
          <p className="sub">
            Upload an encryption bundle, then present the DocumentReader credential that
            authorizes the threshold extraction unlocking the plaintext.
          </p>
        </div>
      </div>
      <div className="grid">
        <div className="stack">
          <section className="panel">
            <h2>Decrypt a document</h2>
            <div
              className={'drop' + (dragging ? ' dragging' : '')}
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
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
              <p>Upload the encryption bundle · encrypted.json</p>
              <input
                id="bundle"
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0])}
                onClick={(e) => e.stopPropagation()}
                ref={fileRef}
              />
              <p className="hint">
                Drag a bundle here, or click to choose a file. The bundle holds the
                manifest and ciphertext written by the Encryption tab; the plaintext is
                never stored alongside it.
              </p>
            </div>

            {m ? (
              <div className="field">
                <h3>{m.title}</h3>
                <p className="hint">
                  Version {m.version} · key slot{' '}
                  <a href={explorer(m.slotId)} target="_blank" rel="noopener noreferrer">
                    {shortSlot(m.slotId)} ↗
                  </a>
                </p>
                <label htmlFor="identity">Identity scope</label>
                <pre className="code" id="identity" title={m.identity}>
                  {shortIdentity(m.identity)}
                </pre>
                <label htmlFor="sha">Document SHA-256</label>
                <pre className="code" id="sha">
                  {m.documentSha256}
                </pre>
              </div>
            ) : null}

            {bundle ? (
              <button className="primary" disabled={busy} onClick={startDecrypt}>
                Decrypt document
              </button>
            ) : null}

            {remote ? (
              <div className="vc-offer">
                <img
                  src={remote.qrDataUrl}
                  alt="Decryption authorization QR code"
                  width={200}
                  height={200}
                />
                <p className="hint">
                  Scan this QR with the holder’s remote wallet, or copy the session URL
                  into it.
                </p>
                <div className="linkbox">{remote.qrPayload}</div>
                <button className="small" type="button" onClick={copyRemote}>
                  {copied ? 'Copied' : 'Copy session URL'}
                </button>
              </div>
            ) : null}
          </section>

          {plaintext ? (
            <section className="panel pdf">
              <div className="pdf-head">
                <span>{pdfName}</span>
                <button className="small" onClick={() => downloadPdf(plaintext, pdfName)}>
                  Download PDF
                </button>
              </div>
              <PdfPreview bytes={plaintext} />
              <small>
                Decrypted in this browser tab. The plaintext is not saved to the server.
              </small>
            </section>
          ) : null}
        </div>

        <aside className="side stack">
          <section className="panel">
            <h2>How decryption works</h2>
            <ol className="timeline">
              <li>The bundle names the key slot and the exact identity scope it was encrypted to.</li>
              <li>Your remote wallet presents the DocumentReader credential against that DCQL rule.</li>
              <li>Two of three keepers combine identity-key shares to open the ciphertext.</li>
            </ol>
          </section>
        </aside>
      </div>
    </>
  )
}
