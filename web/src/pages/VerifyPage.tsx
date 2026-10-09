import { useState } from 'react'
import { api, base64 } from '../api'
import { FileUpload, type UploadedFile } from '../FileUpload'

type SlotLink = { name?: string; slotId: string }

type VerifyResult = { title?: string; version?: number; signers?: SlotLink[] }

const EXPLORER = 'https://explorer.t3-foundry.fuji.tasra.network'

const explorer = (slotId: string) => `${EXPLORER}/slots/${slotId}`

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)

function signerName(s: SlotLink): string {
  return s.name ? cap(s.name) : s.slotId.slice(0, 12) + '…'
}

function listNames(signers: SlotLink[]): string {
  const names = signers.map(signerName)
  if (names.length === 0) return 'A signer'
  if (names.length === 1) return names[0]
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
}

export function VerifyPage() {
  const [status, setStatus] = useState('')
  const [className, setClassName] = useState('')
  const [slots, setSlots] = useState<SlotLink[]>([])
  const [bundle, setBundle] = useState<UploadedFile | null>(null)
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState(false)

  async function verifyBundleZip() {
    if (!bundle || busy) return
    setBusy(true)
    setLocked(true)
    setVerified(false)
    setStatus('Checking…')
    setClassName('')
    setSlots([])
    try {
      const result = await api<VerifyResult>('/verify-zip', {
        zipBase64: base64(bundle.bytes),
      })
      const signers = result.signers ?? []
      setSlots(signers)
      const doc = result.title ? `“${result.title}”` : 'the document'
      setClassName('success')
      setStatus(`Verified. ${listNames(signers)} signed ${doc}.`)
      setVerified(true)
    } catch (e) {
      setClassName('error')
      setStatus(e instanceof Error ? e.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="verify">
      <div className="eyebrow">Independent verification</div>
      <h1>Check the agreement.</h1>
      <p className="sub">
        Upload a signed document bundle to verify both signatures against the current
        on-chain keys.
      </p>
      <section className="panel">
        <h2>Verify signed document from downloaded bundle</h2>
        <p className="hint">
          Upload the single <code>bundle.zip</code> you saved after both signatures were
          completed. It contains the document, request and signatures together.
        </p>
        <FileUpload
          file={bundle}
          onChange={setBundle}
          accept="application/zip,.zip"
          extensions={['zip']}
          label="Drag & drop your bundle here"
          typeLabel="ZIP"
          disabled={locked}
        />
        <div className="verify-actions">
          <button
            className="primary"
            disabled={!bundle || busy || verified}
            onClick={() => void verifyBundleZip()}
          >
            {busy ? 'Verifying…' : 'Verify downloaded bundle'}
          </button>
        </div>
        {verified ? (
          <div className="verify-result">
            <span className="verify-badge" aria-hidden="true">
              ✓
            </span>
            <p id="result" role="status" className={className}>
              {status}
            </p>
          </div>
        ) : (
          <p id="result" role="status" className={className}>
            {status}
          </p>
        )}
        {slots.length ? (
          <div className="slots-callout">
            <p className="slots-callout-title">
              Visit Tasra Explorer to view details of each key slot:
            </p>
            <div className="slots-links">
              {slots.map((s) => (
                <a
                  key={s.slotId}
                  href={explorer(s.slotId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {signerName(s)} ↗
                </a>
              ))}
            </div>
            <a
              className="slots-explorer-link"
              href={EXPLORER}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Tasra Explorer ↗
            </a>
          </div>
        ) : null}
      </section>
    </div>
  )
}